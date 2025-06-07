const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

class TelegramBotManager {
    constructor(config, userManager) {
        this.config = config.telegram;
        this.serverConfig = config.server;
        this.userManager = userManager;
        this.bot = null;
        this.tokens = new Map(); // 存储临时token
        this.userCredentials = new Map(); // 存储用户凭据
        this.groupMembers = new Set(); // 存储群组成员
        this.tokenLimits = new Map(); // 存储token生成限制
        
        // 数据文件路径
        this.dataDir = path.join(__dirname, 'data');
        this.userDataFile = path.join(this.dataDir, 'telegram-users.json');
        this.tokensDataFile = path.join(this.dataDir, 'tokens.json');
        this.tokenLimitsFile = path.join(this.dataDir, 'token-limits.json');
        
        // 确保数据目录存在
        this.ensureDataDirectory();
        
        // 加载持久化数据
        this.loadPersistedData();
        
        if (config.features.enableTelegramBot && this.config.botToken) {
            this.initializeBot();
        }
    }
    
    // 确保数据目录存在
    ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
            console.log('✅ Created data directory for Telegram bot');
        }
    }
    
    // 加载持久化数据
    loadPersistedData() {
        try {
            // 加载用户凭据
            if (fs.existsSync(this.userDataFile)) {
                const userData = JSON.parse(fs.readFileSync(this.userDataFile, 'utf8'));
                
                // 恢复用户凭据
                for (const [userId, credentials] of Object.entries(userData.userCredentials || {})) {
                    this.userCredentials.set(parseInt(userId), credentials);
                }
                
                // 恢复群组成员
                if (userData.groupMembers) {
                    this.groupMembers = new Set(userData.groupMembers);
                }
                
                console.log(`✅ Loaded ${this.userCredentials.size} Telegram users from persistent storage`);
            }
            
            // 加载tokens（只加载未过期的）
            if (fs.existsSync(this.tokensDataFile)) {
                const tokensData = JSON.parse(fs.readFileSync(this.tokensDataFile, 'utf8'));
                const now = Date.now();
                
                for (const [token, tokenData] of Object.entries(tokensData)) {
                    if (tokenData.expiresAt > now && !tokenData.used) {
                        this.tokens.set(token, tokenData);
                    }
                }
                
                console.log(`✅ Loaded ${this.tokens.size} valid tokens from persistent storage`);
            }
            
            // 加载token限制数据
            if (fs.existsSync(this.tokenLimitsFile)) {
                const limitsData = JSON.parse(fs.readFileSync(this.tokenLimitsFile, 'utf8'));
                const now = Date.now();
                
                for (const [userId, limitData] of Object.entries(limitsData)) {
                    // 只加载未过期的限制记录
                    if (limitData.resetTime > now) {
                        this.tokenLimits.set(parseInt(userId), limitData);
                    }
                }
                
                console.log(`✅ Loaded ${this.tokenLimits.size} token limit records from persistent storage`);
            }
            
        } catch (error) {
            console.error('❌ Error loading persisted data:', error);
        }
    }
    
    // 保存用户数据到文件
    saveUserData() {
        try {
            const userData = {
                userCredentials: Object.fromEntries(this.userCredentials),
                groupMembers: Array.from(this.groupMembers),
                lastUpdated: Date.now()
            };
            
            fs.writeFileSync(this.userDataFile, JSON.stringify(userData, null, 2));
        } catch (error) {
            console.error('❌ Error saving user data:', error);
        }
    }
    
    // 保存tokens数据到文件
    saveTokensData() {
        try {
            const tokensData = Object.fromEntries(this.tokens);
            fs.writeFileSync(this.tokensDataFile, JSON.stringify(tokensData, null, 2));
        } catch (error) {
            console.error('❌ Error saving tokens data:', error);
        }
    }
    
    // 保存token限制数据到文件
    saveTokenLimitsData() {
        try {
            const limitsData = Object.fromEntries(this.tokenLimits);
            fs.writeFileSync(this.tokenLimitsFile, JSON.stringify(limitsData, null, 2));
        } catch (error) {
            console.error('❌ Error saving token limits data:', error);
        }
    }
    
    // 验证并恢复用户到用户管理器
    async restoreUsersToManager() {
        let restoredCount = 0;
        let revokedCount = 0;
        
        for (const [userId, credentials] of this.userCredentials.entries()) {
            try {
                // 检查用户是否还在群组中
                const isInGroup = await this.checkUserInGroup(userId);
                
                if (isInGroup) {
                    // 恢复用户到用户管理器
                    this.userManager.createTelegramUser(
                        credentials.username, 
                        credentials.password, 
                        userId
                    );
                    restoredCount++;
                } else {
                    // 用户不在群组中，撤销权限
                    await this.revokeUserAccess(userId, '服务重启后检测到您已不在群组中，访问权限已撤销', false);
                    revokedCount++;
                }
            } catch (error) {
                console.error(`Error restoring user ${userId}:`, error);
                // 如果检查失败，暂时保留用户，稍后再检查
                this.userManager.createTelegramUser(
                    credentials.username, 
                    credentials.password, 
                    userId
                );
                restoredCount++;
            }
        }
        
        console.log(`✅ Restored ${restoredCount} users, revoked ${revokedCount} users`);
        
        // 保存更新后的数据
        if (revokedCount > 0) {
            this.saveUserData();
        }
    }
    
    // 检查用户是否在群组中
    async checkUserInGroup(userId) {
        try {
            if (!this.bot) return true; // 如果机器人未初始化，暂时认为用户有效
            
            const chatMember = await this.bot.getChatMember(this.config.groupId, userId);
            return chatMember.status !== 'left' && 
                   chatMember.status !== 'kicked' && 
                   chatMember.status !== 'banned';
        } catch (error) {
            // 如果无法获取用户状态，可能是网络问题或用户删除了与机器人的对话
            console.log(`Could not check group status for user ${userId}: ${error.message}`);
            return true; // 暂时保留用户
        }
    }
    
    initializeBot() {
        try {
            this.bot = new TelegramBot(this.config.botToken, { polling: true });
            this.setupBotHandlers();
            this.setupBotCommands(); // 设置机器人命令菜单
            console.log('✅ Telegram bot initialized successfully');
            
            // 机器人初始化后，验证并恢复用户
            setTimeout(() => {
                this.restoreUsersToManager();
            }, 5000); // 延迟5秒执行，确保机器人完全启动
            
        } catch (error) {
            console.error('❌ Failed to initialize Telegram bot:', error.message);
        }
    }
    
    // 设置机器人命令菜单
    async setupBotCommands() {
        try {
            const commands = [
                { command: 'start', description: '开始使用机器人' },
                { command: 'gettoken', description: '获取访问token' },
                { command: 'mycredentials', description: '查看我的凭据' },
                { command: 'help', description: '显示帮助信息' },
                { command: 'revoke', description: '撤销我的访问权限' }
            ];
            
            await this.bot.setMyCommands(commands);
            console.log('✅ Bot commands menu set successfully');
        } catch (error) {
            console.error('❌ Failed to set bot commands:', error);
        }
    }
    
    setupBotHandlers() {
        // 处理 /start 命令（仅私聊）
        this.bot.onText(/\/start/, (msg) => {
            this.handleStartCommand(msg);
        });
        
        // 处理 /gettoken 命令
        this.bot.onText(/\/gettoken/, (msg) => {
            this.handleGetTokenCommand(msg);
        });
        
        // 处理 /mycredentials 命令（仅私聊）
        this.bot.onText(/\/mycredentials/, (msg) => {
            this.handleMyCredentialsCommand(msg);
        });
        
        // 处理 /help 命令
        this.bot.onText(/\/help/, (msg) => {
            this.handleHelpCommand(msg);
        });
        
        // 处理 /revoke 命令（仅私聊）
        this.bot.onText(/\/revoke/, (msg) => {
            this.handleRevokeCommand(msg);
        });
        
        // 处理管理员命令（仅私聊）
        this.bot.onText(/\/admin (.+)/, (msg, match) => {
            this.handleAdminCommand(msg, match[1]);
        });
        
        // 处理token验证（仅私聊）
        this.bot.on('message', (msg) => {
            if (msg.text && msg.text.length === 32 && !msg.text.startsWith('/') && msg.chat.type === 'private') {
                this.handleTokenVerification(msg);
            }
        });
        
        // 监听群组成员变化
        this.bot.on('chat_member', (update) => {
            this.handleChatMemberUpdate(update);
        });
        
        // 监听新成员加入
        this.bot.on('new_chat_members', (msg) => {
            this.handleNewChatMembers(msg);
        });
        
        // 监听成员离开
        this.bot.on('left_chat_member', (msg) => {
            this.handleLeftChatMember(msg);
        });
        
        // 错误处理
        this.bot.on('error', (error) => {
            console.error('Telegram bot error:', error);
        });
    }
    
    // 处理群组成员状态变化
    async handleChatMemberUpdate(update) {
        const chatId = update.chat.id;
        const userId = update.new_chat_member.user.id;
        const newStatus = update.new_chat_member.status;
        const oldStatus = update.old_chat_member.status;
        
        // 只处理指定群组的变化
        if (chatId.toString() !== this.config.groupId) {
            return;
        }
        
        console.log(`Chat member update: User ${userId} status changed from ${oldStatus} to ${newStatus}`);
        
        // 如果用户被踢出、封禁或离开群组
        if (newStatus === 'left' || newStatus === 'kicked' || newStatus === 'banned') {
            await this.revokeUserAccess(userId, '您已被移出群组，访问权限已自动撤销');
        }
        
        // 如果用户重新加入群组
        if ((oldStatus === 'left' || oldStatus === 'kicked') && (newStatus === 'member' || newStatus === 'administrator' || newStatus === 'creator')) {
            this.groupMembers.add(userId);
            this.saveUserData(); // 保存群组成员变化
        }
    }
    
    // 处理新成员加入
    async handleNewChatMembers(msg) {
        const chatId = msg.chat.id;
        
        if (chatId.toString() !== this.config.groupId) {
            return;
        }
        
        msg.new_chat_members.forEach(member => {
            this.groupMembers.add(member.id);
            console.log(`New member joined: ${member.id}`);
        });
        
        this.saveUserData(); // 保存群组成员变化
    }
    
    // 处理成员离开
    async handleLeftChatMember(msg) {
        const chatId = msg.chat.id;
        const userId = msg.left_chat_member.id;
        
        if (chatId.toString() !== this.config.groupId) {
            return;
        }
        
        console.log(`Member left: ${userId}`);
        await this.revokeUserAccess(userId, '您已离开群组，访问权限已自动撤销');
    }
    
    // 撤销用户访问权限
    async revokeUserAccess(userId, reason, saveData = true) {
        const credentials = this.userCredentials.get(userId);
        
        if (credentials) {
            try {
                // 从用户管理器中删除用户（这会自动清理播放列表限制）
                this.userManager.removeTelegramUser(credentials.username);
                
                // 手动重置播放列表限制（确保清理）
                if (this.userManager.resetUserPlaylistLimit) {
                    this.userManager.resetUserPlaylistLimit(credentials.username);
                }
                
                // 删除本地凭据
                this.userCredentials.delete(userId);
                
                // 清理该用户的所有token
                for (const [token, tokenData] of this.tokens.entries()) {
                    if (tokenData.userId === userId) {
                        this.tokens.delete(token);
                    }
                }
                
                // 从群组成员列表中移除
                this.groupMembers.delete(userId);
                
                // 保存数据变化
                if (saveData) {
                    this.saveUserData();
                    this.saveTokensData();
                }
                
                // 通知用户（如果可能）
                try {
                    await this.bot.sendMessage(userId, `🚫 ${reason}`);
                } catch (error) {
                    console.log(`Could not notify user ${userId}: ${error.message}`);
                }
                
                console.log(`✅ Revoked access for user ${userId}: ${credentials.username}`);
                
            } catch (error) {
                console.error(`Error revoking access for user ${userId}:`, error);
            }
        }
    }
    
    async handleStartCommand(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // 只在私聊中处理
        if (msg.chat.type !== 'private') {
            return;
        }
        
        const welcomeMessage = `
🎬 **欢迎使用IPTV访问机器人！**

📺 通过此机器人，您可以获取专属的IPTV访问凭据。

🔧 **快速开始：**

1️⃣ **确保群组成员身份**
   • 您必须是指定IPTV群组的成员

2️⃣ **获取访问Token**
   • 发送 \`/gettoken\` 命令

3️⃣ **验证Token**
   • 将收到的token直接发送给机器人

4️⃣ **获得凭据**
   • 收到您的专属IPTV访问信息

📋 **可用命令：**
• \`/gettoken\` - 获取访问token
• \`/mycredentials\` - 查看我的凭据
• \`/revoke\` - 撤销访问权限
• \`/help\` - 详细使用指南

⚠️ **重要提醒：**
• 每5小时最多生成2个token
• 播放列表5小时内最多请求2次
• 离开群组后访问权限自动撤销

发送 \`/help\` 获取详细使用指南。
    `;
    
    await this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    }
    
    async handleGetTokenCommand(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const username = msg.from.username || msg.from.first_name;
        
        // 只在私聊中处理
        if (msg.chat.type !== 'private') {
            await this.bot.sendMessage(chatId, '🔒 请私聊机器人使用此命令。');
            return;
        }
        
        try {
            // 验证用户是否在群组中
            const chatMember = await this.bot.getChatMember(this.config.groupId, userId);
            if (chatMember.status === 'left' || chatMember.status === 'kicked' || chatMember.status === 'banned') {
                await this.bot.sendMessage(chatId, `
❌ **无法生成Token**

您不在指定的群组中，无法获取访问权限。

🔗 **解决方案：**
1. 请先加入指定的IPTV群组
2. 确保您是群组的正式成员
3. 然后重新尝试获取token

如需帮助，请联系管理员。
            `, { parse_mode: 'Markdown' });
            return;
        }
    } catch (error) {
        console.error('Error checking chat member status:', error);
        await this.bot.sendMessage(chatId, '❌ 无法验证您的群组状态，请稍后重试。');
        return;
    }
    
    try {
        // 检查token生成限制
        const limitCheck = this.checkTokenGenerationLimit(userId);
        if (!limitCheck.allowed) {
            await this.bot.sendMessage(chatId, `
🚫 **Token生成限制已达上限**

您在5小时内已生成了 ${limitCheck.count}/${limitCheck.maxCount} 个token。

⏰ **重置时间：** ${limitCheck.remainingTime} 分钟后

🔄 **解决方案：**
1. 等待 ${limitCheck.remainingTime} 分钟后重试
2. 或使用 \`/revoke\` 撤销现有凭据后重新生成

💡 **提示：** 为避免频繁生成token，请妥善保管您的凭据。
            `, { parse_mode: 'Markdown' });
            return;
        }
        
        // 检查用户是否已有太多未使用的token
        const userTokens = Array.from(this.tokens.values()).filter(t => t.userId === userId && !t.used);
        if (userTokens.length >= this.config.maxTokensPerUser) {
            await this.bot.sendMessage(chatId, `
❌ **Token数量限制**

您已有 ${userTokens.length} 个未使用的token（最大限制：${this.config.maxTokensPerUser}）。

🔄 **解决方案：**
1. 使用现有的token获取凭据
2. 或等待现有token过期
3. 或使用 \`/revoke\` 命令清理现有凭据

💡 **提示：** 每个token有效期为 ${Math.floor(this.config.tokenExpiry / 3600000)} 小时。
            `, { parse_mode: 'Markdown' });
            return;
        }
        
        // 生成新的token
        const token = this.generateToken();
        const expiresAt = Date.now() + this.config.tokenExpiry;
        
        this.tokens.set(token, {
            userId: userId,
            username: username,
            chatId: chatId,
            createdAt: Date.now(),
            expiresAt: expiresAt,
            used: false
        });
        
        // 增加token生成计数
        this.incrementTokenGenerationCount(userId);
        
        // 保存数据
        this.saveTokensData();
        this.saveTokenLimitsData();
        
        const expiryMinutes = Math.floor(this.config.tokenExpiry / 60000);
        const limitCheck2 = this.checkTokenGenerationLimit(userId);
        
        await this.bot.sendMessage(chatId, `
🎫 **Token生成成功**

\`${token}\`

⏰ **有效期：** ${expiryMinutes} 分钟
📊 **生成统计：** ${limitCheck2.count}/${limitCheck2.maxCount} (5小时内)

📝 **下一步：**
直接发送此token给机器人即可获取您的IPTV凭据。

⚠️ **注意事项：**
• 此token只能使用一次
• 请在有效期内使用
• 不要分享给他人
        `, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('Error generating token:', error);
        await this.bot.sendMessage(chatId, '❌ 生成token时发生错误，请稍后重试。');
    }
}
    
    async handleTokenVerification(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const token = msg.text.trim();
        
        // 只在私聊中处理token验证
        if (msg.chat.type !== 'private') {
            return;
        }
        
        const tokenData = this.tokens.get(token);
        
        if (!tokenData) {
            await this.bot.sendMessage(chatId, '❌ 无效的token或token已过期。');
            return;
        }
        
        if (tokenData.used) {
            await this.bot.sendMessage(chatId, '❌ 此token已被使用。');
            return;
        }
        
        if (Date.now() > tokenData.expiresAt) {
            this.tokens.delete(token);
            this.saveTokensData();
            await this.bot.sendMessage(chatId, '❌ Token已过期。');
            return;
        }
        
        if (tokenData.userId !== userId) {
            await this.bot.sendMessage(chatId, '❌ 此token不属于您。');
            return;
        }
        
        // 验证用户是否还在群组中
        try {
            const chatMember = await this.bot.getChatMember(this.config.groupId, userId);
            if (chatMember.status === 'left' || chatMember.status === 'kicked' || chatMember.status === 'banned') {
                await this.bot.sendMessage(chatId, '❌ 您已不在群组中，无法使用此token。');
                this.tokens.delete(token);
                this.saveTokensData();
                return;
            }
        } catch (error) {
            console.error('Error checking chat member status:', error);
            await this.bot.sendMessage(chatId, '❌ 无法验证您的群组状态，请稍后重试。');
            return;
        }
        
        try {
            // 标记token为已使用
            tokenData.used = true;
            
            // 生成用户凭据
            const credentials = this.generateUserCredentials(userId, tokenData.username);
            
            // 如果用户已存在，先撤销旧的访问权限
            const existingCredentials = this.userCredentials.get(userId);
            if (existingCredentials) {
                console.log(`🔄 User ${userId} already has credentials, revoking old access...`);
                await this.revokeUserAccess(userId, '重新生成token，撤销旧的访问权限', false);
            }
            
            // 保存用户凭据
            this.userCredentials.set(userId, credentials);
            this.saveUserData();
            
            // 在用户管理器中创建用户（这会清理旧的限制记录）
            this.userManager.createTelegramUser(credentials.username, credentials.password, userId);
            
            // 保存tokens数据
            this.saveTokensData();
            
            // 生成各种播放链接
            const serverUrl = this.getServerUrl();
            const m3uLink = `${serverUrl}/get.php?username=${credentials.username}&password=${credentials.password}&type=m3u_plus`;
            const m3uSimpleLink = `${serverUrl}/get.php?username=${credentials.username}&password=${credentials.password}&type=m3u`;
            const playerApiLink = `${serverUrl}/player_api.php?username=${credentials.username}&password=${credentials.password}`;
            
            const credentialsMessage = `
🎉 恭喜！您的IPTV访问凭据已生成：

📺 基本信息：
🌐 服务器地址: \`${serverUrl}\`
👤 用户名: \`${credentials.username}\`
🔐 密码: \`${credentials.password}\`
🔗 最大连接数: ${credentials.maxConnections}

📱 直接播放链接：

🎬 **M3U Plus播放列表** (推荐):
\`${m3uLink}\`

📺 **M3U简单播放列表**:
\`${m3uSimpleLink}\`

🔧 **Player API接口**:
\`${playerApiLink}\`

⚠️ **请求限制提醒：**
- 播放列表链接在5小时内最多只能请求2次
- 超过限制后链接将失效，需要重新生成token

📖 使用方法：
**方法1 - 直接导入播放列表：**
1. 复制上面的M3U Plus链接
2. 在IPTV播放器中选择"添加播放列表"
3. 粘贴链接即可

**方法2 - Xtream Codes配置：**
1. 在IPTV播放器中选择"Xtream Codes"
2. 服务器: \`${serverUrl}\`
3. 用户名: \`${credentials.username}\`
4. 密码: \`${credentials.password}\`

⚠️ 重要提醒：
- 请妥善保管这些凭据和链接
- 不要与他人分享
- 如需撤销访问权限，请使用 /revoke 命令
            `;
            
            await this.bot.sendMessage(chatId, credentialsMessage, { parse_mode: 'Markdown' });
            
            // 清理已使用的token
            setTimeout(() => {
                this.tokens.delete(token);
                this.saveTokensData();
            }, 60000); // 1分钟后删除
            
        } catch (error) {
            console.error('Error processing token verification:', error);
            await this.bot.sendMessage(chatId, '❌ 处理token时发生错误，请联系管理员。');
        }
    }
    
    async handleMyCredentialsCommand(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // 只在私聊中处理
        if (msg.chat.type !== 'private') {
            await this.bot.sendMessage(chatId, '🔒 请私聊机器人查看您的凭据信息。');
            return;
        }
        
        const credentials = this.userCredentials.get(userId);
        
        if (!credentials) {
            await this.bot.sendMessage(chatId, `
❌ **没有找到凭据**

您还没有生成IPTV访问凭据。

🔄 **获取凭据：**
1. 发送 \`/gettoken\` 获取访问token
2. 将收到的token发送给机器人
3. 获得您的专属IPTV凭据

需要帮助请发送 \`/help\` 查看详细指南。
        `, { parse_mode: 'Markdown' });
            return;
        }
        
        // 验证用户是否还在群组中
        try {
            const chatMember = await this.bot.getChatMember(this.config.groupId, userId);
            if (chatMember.status === 'left' || chatMember.status === 'kicked' || chatMember.status === 'banned') {
                await this.revokeUserAccess(userId, '您已不在群组中，访问权限已自动撤销');
                return;
            }
        } catch (error) {
            console.error('Error checking group membership:', error);
            await this.bot.sendMessage(chatId, '❌ 无法验证您的群组状态，请稍后重试。');
            return;
        }
        
        // 生成播放链接
        const serverUrl = this.getServerUrl();
        const m3uLink = `${serverUrl}/get.php?username=${credentials.username}&password=${credentials.password}&type=m3u_plus`;
        const m3uSimpleLink = `${serverUrl}/get.php?username=${credentials.username}&password=${credentials.password}&type=m3u`;
        const playerApiLink = `${serverUrl}/player_api.php?username=${credentials.username}&password=${credentials.password}`;
        
        const credentialsMessage = `
📺 **您的IPTV访问凭据**

🌐 **服务器地址：** \`${serverUrl}\`
👤 **用户名：** \`${credentials.username}\`
🔐 **密码：** \`${credentials.password}\`
🔗 **最大连接数：** ${credentials.maxConnections}

📱 **播放列表链接：**

🎬 **M3U Plus** (推荐):
\`${m3uLink}\`

📺 **M3U简单格式**:
\`${m3uSimpleLink}\`

🔧 **Player API接口**:
\`${playerApiLink}\`

⚠️ **使用限制提醒：**
• 播放列表链接5小时内最多请求2次
• 超过限制后需重新生成token
• 建议下载后保存到本地使用

📖 **使用方法：**
1. 复制M3U Plus链接
2. 在IPTV播放器中导入
3. 或使用Xtream Codes配置

🔄 **管理命令：**
• \`/revoke\` - 撤销当前凭据
• \`/gettoken\` - 重新生成token
    `;
        
        await this.bot.sendMessage(chatId, credentialsMessage, { parse_mode: 'Markdown' });
    }
    
    async handleRevokeCommand(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // 只在私聊中处理
        if (msg.chat.type !== 'private') {
            await this.bot.sendMessage(chatId, '🔒 请私聊机器人使用此命令。');
            return;
        }
        
        const credentials = this.userCredentials.get(userId);
        
        if (!credentials) {
            await this.bot.sendMessage(chatId, `
❌ **没有找到凭据**

您还没有生成过IPTV访问凭据。

🔄 **获取凭据：**
1. 发送 \`/gettoken\` 获取访问token
2. 将收到的token发送给机器人
3. 获得您的专属IPTV凭据

需要帮助请发送 \`/help\` 查看详细指南。
        `, { parse_mode: 'Markdown' });
            return;
        }
        
        try {
            // 撤销用户访问权限
            await this.revokeUserAccess(userId, '用户主动撤销访问权限', false);
            
            await this.bot.sendMessage(chatId, `
✅ **访问权限已撤销**

您的IPTV访问凭据已被成功撤销。

🔄 **重新获取访问权限：**
1. 发送 \`/gettoken\` 命令获取新token
2. 将新token发送给机器人
3. 获得新的凭据和播放列表链接

💡 **提示：**
• 新凭据将重置所有使用限制
• 播放列表请求限制重新计算
• 旧的播放列表链接将失效

如需帮助，请发送 \`/help\` 查看使用指南。
        `, { parse_mode: 'Markdown' });
            
        } catch (error) {
            console.error('Error revoking user access:', error);
            await this.bot.sendMessage(chatId, '❌ 撤销访问权限时发生错误，请稍后重试。');
        }
    }
    
    async handleHelpCommand(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const isPrivateChat = msg.chat.type === 'private';
        const isInGroup = chatId.toString() === this.config.groupId;
        
        if (isPrivateChat) {
            // 私聊中的完整帮助信息
            const helpMessage = `
🤖 **IPTV访问机器人使用指南**

📋 **可用命令：**

🎫 \`/gettoken\` - 获取访问token
📺 \`/mycredentials\` - 查看我的凭据
🚫 \`/revoke\` - 撤销我的访问权限
❓ \`/help\` - 显示此帮助信息

📖 **使用流程：**

1️⃣ **获取Token**
   • 私聊机器人发送 \`/gettoken\`
   • 系统会验证您是否在指定群组中
   • 每5小时最多可获取2个token

2️⃣ **验证Token**
   • 收到token后，直接发送给机器人
   • 系统会生成您的专属IPTV凭据

3️⃣ **使用凭据**
   • 获得M3U播放列表链接
   • 在IPTV播放器中导入链接
   • 开始观看节目

⚠️ **重要限制：**

🔄 **Token生成限制**
- 每个用户5小时内最多生成2个token
- 超过限制需等待重置时间

📺 **播放列表限制**
- 每个凭据5小时内最多请求播放列表2次
- 超过限制后凭据失效，需重新生成

🔐 **群组验证**
- 必须是指定群组成员才能使用
- 离开群组后访问权限自动撤销

�� **使用建议：**
- 下载播放列表后保存到本地
- 避免频繁刷新播放列表
- 妥善保管凭据，不要分享给他人

如有问题，请联系管理员。
            `;
            
            await this.bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
            
        } else if (isInGroup) {
            // 群聊中的简化帮助信息
            const groupHelpMessage = `
🤖 **IPTV访问机器人**

📱 **私聊机器人获取IPTV访问权限**

🔧 **主要功能：**
• 生成专属IPTV访问凭据
• 提供M3U播放列表链接
• 支持Xtream Codes协议

⚠️ **使用说明：**
• 请私聊机器人使用所有功能
• 发送 \`/help\` 到私聊获取详细指南
• 仅群组成员可使用此服务

👆 点击机器人头像开始私聊
            `;
            
            await this.bot.sendMessage(chatId, groupHelpMessage, { parse_mode: 'Markdown' });
        } else {
            // 非指定群组
            await this.bot.sendMessage(chatId, '❌ 此机器人只能在指定群组中使用。');
        }
    }
    
    async handleAdminCommand(msg, command) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // 检查是否为管理员
        if (userId.toString() !== this.config.adminUserId) {
            await this.bot.sendMessage(chatId, '❌ 您没有管理员权限。');
            return;
        }
        
        const [action, ...params] = command.split(' ');
        
        switch (action) {
            case 'stats':
                await this.handleAdminStats(chatId);
                break;
            case 'cleanup':
                await this.handleAdminCleanup(chatId);
                break;
            case 'list':
                await this.handleAdminList(chatId);
                break;
            case 'delete':
                if (params.length > 0) {
                    await this.handleAdminDeleteUser(chatId, params[0]);
                } else {
                    await this.bot.sendMessage(chatId, '❌ 请指定要删除的用户ID或用户名。\n用法: /admin delete <用户ID或用户名>');
                }
                break;
            case 'deletebyid':
                if (params.length > 0) {
                    await this.handleAdminDeleteUserById(chatId, params[0]);
                } else {
                    await this.bot.sendMessage(chatId, '❌ 请指定要删除的Telegram用户ID。\n用法: /admin deletebyid <Telegram用户ID>');
                }
                break;
            case 'backup':
                await this.handleAdminBackup(chatId);
                break;
            case 'restore':
                await this.handleAdminRestore(chatId);
                break;
            default:
                await this.bot.sendMessage(chatId, `
🔧 管理员命令：

/admin stats - 查看统计信息
/admin cleanup - 清理过期token
/admin list - 列出所有用户
/admin delete <用户名> - 删除指定用户名的用户
/admin deletebyid <用户ID> - 删除指定Telegram ID的用户
/admin backup - 备份用户数据
/admin restore - 恢复用户数据

📝 示例：
/admin delete tg_12345678
/admin deletebyid 123456789
                `);
        }
    }
    
    async handleAdminStats(chatId) {
        const activeTokens = Array.from(this.tokens.values()).filter(t => !t.used && Date.now() < t.expiresAt);
        const totalUsers = this.userCredentials.size;
        
        const statsMessage = `
📊 系统统计信息：

👥 总用户数: ${totalUsers}
🎫 活跃Token数: ${activeTokens.length}
🗂️ 总Token数: ${this.tokens.size}
👥 群组成员数: ${this.groupMembers.size}
🌐 服务器地址: ${this.getServerUrl()}
💾 数据文件状态: ${fs.existsSync(this.userDataFile) ? '✅ 存在' : '❌ 不存在'}
⏰ 最后更新: ${new Date().toLocaleString('zh-CN')}
        `;
        
        await this.bot.sendMessage(chatId, statsMessage);
    }
    
    async handleAdminCleanup(chatId) {
        let cleanedCount = 0;
        
        for (const [token, tokenData] of this.tokens.entries()) {
            if (Date.now() > tokenData.expiresAt) {
                this.tokens.delete(token);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            this.saveTokensData();
        }
        
        await this.bot.sendMessage(chatId, `✅ 已清理 ${cleanedCount} 个过期token。`);
    }
    
    async handleAdminList(chatId) {
        const users = Array.from(this.userCredentials.values());
        
        if (users.length === 0) {
            await this.bot.sendMessage(chatId, '📝 当前没有用户。');
            return;
        }
        
        let userList = '👥 用户列表：\n\n';
        users.forEach((user, index) => {
            const createDate = new Date(user.createdAt).toLocaleDateString('zh-CN');
            userList += `${index + 1}. ${user.username}\n`;
            userList += `   📱 Telegram ID: ${user.telegramUserId}\n`;
            userList += `   📅 创建时间: ${createDate}\n`;
            userList += `   👤 Telegram用户: ${user.telegramUsername || 'N/A'}\n\n`;
        });
        
        // 如果消息太长，分段发送
        if (userList.length > 4000) {
            const chunks = this.splitMessage(userList, 4000);
            for (const chunk of chunks) {
                await this.bot.sendMessage(chatId, chunk);
            }
        } else {
            await this.bot.sendMessage(chatId, userList);
        }
    }
    
    async handleAdminDeleteUser(chatId, username) {
        let deletedUser = null;
        
        // 查找要删除的用户
        for (const [userId, credentials] of this.userCredentials.entries()) {
            if (credentials.username === username) {
                deletedUser = { userId, credentials };
                break;
            }
        }
        
        if (!deletedUser) {
            await this.bot.sendMessage(chatId, `❌ 未找到用户名为 "${username}" 的用户。`);
            return;
        }
        
        try {
            await this.revokeUserAccess(deletedUser.userId, '管理员已删除您的访问权限');
            await this.bot.sendMessage(chatId, `✅ 已成功删除用户: ${username}\n📱 Telegram ID: ${deletedUser.credentials.telegramUserId}`);
        } catch (error) {
            console.error('Error deleting user:', error);
            await this.bot.sendMessage(chatId, `❌ 删除用户时发生错误: ${error.message}`);
        }
    }
    
    async handleAdminDeleteUserById(chatId, telegramUserId) {
        const userId = parseInt(telegramUserId);
        const credentials = this.userCredentials.get(userId);
        
        if (!credentials) {
            await this.bot.sendMessage(chatId, `❌ 未找到Telegram ID为 "${telegramUserId}" 的用户。`);
            return;
        }
        
        try {
            await this.revokeUserAccess(userId, '管理员已删除您的访问权限');
            await this.bot.sendMessage(chatId, `✅ 已成功删除用户: ${credentials.username}\n📱 Telegram ID: ${telegramUserId}`);
        } catch (error) {
            console.error('Error deleting user by ID:', error);
            await this.bot.sendMessage(chatId, `❌ 删除用户时发生错误: ${error.message}`);
        }
    }
    
    async handleAdminBackup(chatId) {
        try {
            const backupData = {
                userCredentials: Object.fromEntries(this.userCredentials),
                groupMembers: Array.from(this.groupMembers),
                tokens: Object.fromEntries(this.tokens),
                backupTime: Date.now(),
                version: '1.0'
            };
            
            const backupFileName = `telegram-backup-${new Date().toISOString().split('T')[0]}.json`;
            const backupPath = path.join(this.dataDir, backupFileName);
            
            fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
            
            await this.bot.sendMessage(chatId, `✅ 数据备份完成\n📁 文件: ${backupFileName}\n📊 用户数: ${this.userCredentials.size}`);
        } catch (error) {
            console.error('Error creating backup:', error);
            await this.bot.sendMessage(chatId, `❌ 备份失败: ${error.message}`);
        }
    }
    
    async handleAdminRestore(chatId) {
        try {
            // 查找最新的备份文件
            const backupFiles = fs.readdirSync(this.dataDir)
                .filter(file => file.startsWith('telegram-backup-') && file.endsWith('.json'))
                .sort()
                .reverse();
            
            if (backupFiles.length === 0) {
                await this.bot.sendMessage(chatId, '❌ 未找到备份文件。');
                return;
            }
            
            const latestBackup = backupFiles[0];
            const backupPath = path.join(this.dataDir, latestBackup);
            const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
            
            // 恢复数据
            this.userCredentials.clear();
            for (const [userId, credentials] of Object.entries(backupData.userCredentials || {})) {
                this.userCredentials.set(parseInt(userId), credentials);
            }
            
            this.groupMembers = new Set(backupData.groupMembers || []);
            
            // 保存恢复的数据
            this.saveUserData();
            
            // 恢复用户到用户管理器
            await this.restoreUsersToManager();
            
            await this.bot.sendMessage(chatId, `✅ 数据恢复完成\n📁 文件: ${latestBackup}\n📊 恢复用户数: ${this.userCredentials.size}`);
        } catch (error) {
            console.error('Error restoring backup:', error);
            await this.bot.sendMessage(chatId, `❌ 恢复失败: ${error.message}`);
        }
    }
    
    // 分割长消息
    splitMessage(message, maxLength) {
        const chunks = [];
        let currentChunk = '';
        const lines = message.split('\n');
        
        for (const line of lines) {
            if (currentChunk.length + line.length + 1 > maxLength) {
                if (currentChunk) {
                    chunks.push(currentChunk);
                    currentChunk = '';
                }
            }
            currentChunk += (currentChunk ? '\n' : '') + line;
        }
        
        if (currentChunk) {
            chunks.push(currentChunk);
        }
        
        return chunks;
    }
    
    generateToken() {
        return crypto.randomBytes(16).toString('hex');
    }
    
    generateUserCredentials(userId, username) {
        const uniqueId = crypto.createHash('md5').update(userId.toString()).digest('hex').substring(0, 8);
        const credentials = {
            username: `tg_${uniqueId}`,
            password: crypto.randomBytes(12).toString('hex'),
            maxConnections: 2,
            createdAt: Date.now(),
            telegramUserId: userId,
            telegramUsername: username
        };
        
        return credentials;
    }
    
    getServerUrl() {
        // 根据配置文件和环境变量确定服务器URL
        const host = this.serverConfig.host === '0.0.0.0' ? 'localhost' : this.serverConfig.host;
        const port = this.serverConfig.port;
        return process.env.SERVER_URL || `http://${host}:${port}`;
    }
    
    // 检查token生成限制
    checkTokenGenerationLimit(userId) {
        const now = Date.now();
        const limitData = this.tokenLimits.get(userId);
        const maxTokensPerPeriod = 2; // 5小时内最多2个token
        const limitPeriod = 5 * 60 * 60 * 1000; // 5小时
        
        if (!limitData || now > limitData.resetTime) {
            // 没有限制记录或已过期，允许生成
            return {
                allowed: true,
                count: 0,
                maxCount: maxTokensPerPeriod,
                remainingTime: 0
            };
        }
        
        if (limitData.count >= maxTokensPerPeriod) {
            // 已达到限制
            const remainingTime = Math.ceil((limitData.resetTime - now) / 60000); // 转换为分钟
            return {
                allowed: false,
                count: limitData.count,
                maxCount: maxTokensPerPeriod,
                remainingTime: remainingTime
            };
        }
        
        // 未达到限制
        return {
            allowed: true,
            count: limitData.count,
            maxCount: maxTokensPerPeriod,
            remainingTime: 0
        };
    }
    
    // 增加token生成计数
    incrementTokenGenerationCount(userId) {
        const now = Date.now();
        const limitPeriod = 5 * 60 * 60 * 1000; // 5小时
        let limitData = this.tokenLimits.get(userId);
        
        if (!limitData || now > limitData.resetTime) {
            // 创建新的限制记录
            limitData = {
                count: 1,
                resetTime: now + limitPeriod,
                firstTokenTime: now
            };
        } else {
            // 增加计数
            limitData.count++;
        }
        
        this.tokenLimits.set(userId, limitData);
    }
    
    // 清理过期token的定时任务
    startCleanupTask() {
        setInterval(() => {
            const now = Date.now();
            let cleanedCount = 0;
            
            // 清理过期tokens
            for (const [token, tokenData] of this.tokens.entries()) {
                if (now > tokenData.expiresAt) {
                    this.tokens.delete(token);
                    cleanedCount++;
                }
            }
            
            // 清理过期的token限制记录
            let cleanedLimitsCount = 0;
            for (const [userId, limitData] of this.tokenLimits.entries()) {
                if (now > limitData.resetTime) {
                    this.tokenLimits.delete(userId);
                    cleanedLimitsCount++;
                }
            }
            
            if (cleanedCount > 0) {
                this.saveTokensData();
                console.log(`🧹 Cleaned up ${cleanedCount} expired tokens`);
            }
            
            if (cleanedLimitsCount > 0) {
                this.saveTokenLimitsData();
                console.log(`🧹 Cleaned up ${cleanedLimitsCount} expired token limits`);
            }
        }, 300000); // 每5分钟清理一次
    }
    
    // 定期检查群组成员状态
    startMemberCheckTask() {
        setInterval(async () => {
            let checkedCount = 0;
            let revokedCount = 0;
            
            for (const userId of this.userCredentials.keys()) {
                try {
                    const isInGroup = await this.checkUserInGroup(userId);
                    checkedCount++;
                    
                    if (!isInGroup) {
                        await this.revokeUserAccess(userId, '定期检查发现您已不在群组中，访问权限已撤销', false);
                        revokedCount++;
                    }
                } catch (error) {
                    console.log(`Could not check member status for user ${userId}: ${error.message}`);
                }
            }
            
            if (revokedCount > 0) {
                this.saveUserData();
                console.log(`🔍 Checked ${checkedCount} users, revoked ${revokedCount} users`);
            }
        }, 600000); // 每10分钟检查一次
    }
    
    // 定期保存数据
    startDataSaveTask() {
        setInterval(() => {
            this.saveUserData();
            this.saveTokensData();
            this.saveTokenLimitsData();
        }, 1800000); // 每30分钟保存一次
    }
    
    // 获取用户凭据（供主服务器使用）
    getUserCredentials(userId) {
        return this.userCredentials.get(userId);
    }
    
    // 验证用户是否有效（供主服务器使用）
    isValidTelegramUser(username) {
        for (const credentials of this.userCredentials.values()) {
            if (credentials.username === username) {
                return true;
            }
        }
        return false;
    }
    
    // 启动所有定时任务
    startAllTasks() {
        this.startCleanupTask();
        this.startMemberCheckTask();
        this.startDataSaveTask();
        console.log('✅ All Telegram bot tasks started');
    }
    
    // 优雅关闭
    async gracefulShutdown() {
        console.log('🔄 Saving Telegram bot data before shutdown...');
        this.saveUserData();
        this.saveTokensData();
        this.saveTokenLimitsData();
        
        if (this.bot) {
            await this.bot.stopPolling();
        }
        
        console.log('✅ Telegram bot shutdown complete');
    }
}

module.exports = TelegramBotManager; 