const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

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
        
        // 初始化管理员列表
        this.initializeAdminList();
    }
    
    // 新增：初始化管理员列表
    initializeAdminList() {
        // 支持旧配置格式的兼容性
        if (this.config.adminUserId && !this.config.adminUserIds) {
            this.config.adminUserIds = [this.config.adminUserId];
        }
        
        // 确保管理员列表存在
        if (!this.config.adminUserIds) {
            this.config.adminUserIds = [];
        }
        
        console.log(`✅ Initialized admin list: ${this.config.adminUserIds.length} admins`);
    }
    
    // 新增：检查用户是否为管理员
    isAdmin(userId) {
        const userIdStr = userId.toString();
        
        // 检查新格式的管理员列表
        if (this.config.adminUserIds?.includes(userIdStr)) {
            return true;
        }
        
        // 兼容旧格式
        if (this.config.adminUserId === userIdStr) {
            return true;
        }
        
        return false;
    }
    
    // 新增：获取主管理员ID（用于通知）
    getPrimaryAdminId() {
        if (this.config.adminUserIds?.length > 0) {
            return this.config.adminUserIds[0];
        }
        return this.config.adminUserId || null;
    }
    
    // 新增：获取所有管理员ID
    getAllAdminIds() {
        const adminIds = [];
        
        if (this.config.adminUserIds) {
            adminIds.push(...this.config.adminUserIds);
        }
        
        // 兼容旧格式
        if (this.config.adminUserId && !adminIds.includes(this.config.adminUserId)) {
            adminIds.push(this.config.adminUserId);
        }
        
        return adminIds;
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
            // 普通用户命令
            const userCommands = [
                { command: 'start', description: '开始使用机器人' },
                { command: 'gettoken', description: '获取访问token' },
                { command: 'mycredentials', description: '查看我的凭据' },
                { command: 'status', description: '查看使用状态' },
                { command: 'help', description: '显示帮助信息' },
                { command: 'revoke', description: '撤销我的访问权限' }
            ];
            
            // 管理员命令（包含普通用户命令 + 管理员专用命令）
            const adminCommands = [
                { command: 'start', description: '开始使用机器人' },
                { command: 'gettoken', description: '获取访问token' },
                { command: 'mycredentials', description: '查看我的凭据' },
                { command: 'status', description: '查看使用状态' },
                { command: 'help', description: '显示帮助信息' },
                { command: 'revoke', description: '撤销我的访问权限' },
                { command: 'refresh', description: '🔧 手动刷新原始服务器' },
                { command: 'admin', description: '🛠️ 管理员命令面板' },
                { command: 'addadmin', description: '👑 添加新管理员' },
                { command: 'removeadmin', description: '🚫 移除管理员' },
                { command: 'listadmins', description: '📋 查看管理员列表' }
            ];
            
            // 设置默认命令（普通用户）
            await this.bot.setMyCommands(userCommands);
            
            // 为所有管理员设置专用命令菜单
            const adminIds = this.getAllAdminIds();
            for (const adminId of adminIds) {
                try {
                    await this.bot.setMyCommands(adminCommands, {
                        scope: {
                            type: 'chat',
                            chat_id: parseInt(adminId)
                        }
                    });
                    console.log(`✅ Admin commands set for admin: ${adminId}`);
                } catch (error) {
                    console.warn(`⚠️ Could not set admin commands for ${adminId}:`, error.message);
                }
            }
            
            console.log('✅ Bot commands menu updated successfully');
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
        
        // 处理 /status 命令
        this.bot.onText(/\/status/, (msg) => {
            this.handleStatusCommand(msg);
        });
        
        // 处理 /help 命令
        this.bot.onText(/\/help/, (msg) => {
            this.handleHelpCommand(msg);
        });
        
        // 处理 /revoke 命令（仅私聊）
        this.bot.onText(/\/revoke/, (msg) => {
            this.handleRevokeCommand(msg);
        });
        
        // 新增：处理 /refresh 命令（管理员专用）
        this.bot.onText(/\/refresh/, (msg) => {
            this.handleRefreshCommand(msg);
        });
        
        // 处理 /admin 命令（管理员专用）
        this.bot.onText(/\/admin\s*(.*)/, (msg, match) => {
            const command = match[1].trim() || '';
            if (command) {
                this.handleAdminCommand(msg, command);
            } else {
                this.handleAdminPanel(msg);
            }
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
        
        // 新增：处理管理员管理命令
        this.bot.onText(/\/addadmin/, (msg) => {
            this.handleAddAdminCommand(msg);
        });
        
        this.bot.onText(/\/removeadmin/, (msg) => {
            this.handleRemoveAdminCommand(msg);
        });
        
        this.bot.onText(/\/listadmins/, (msg) => {
            this.handleListAdminsCommand(msg);
        });
        
        // 新增：处理检查管理员状态命令（调试用）
        this.bot.onText(/\/checkadmin/, (msg) => {
            this.handleCheckAdminCommand(msg);
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
🎬 **欢迎使用智能IPTV播放列表机器人！**

📺 **核心特性：**
• 🔐 **加密链接保护** - 防止直接复制使用
• 📱 **多设备支持** - 最多3个设备同时使用
• ⏰ **智能有效期** - 链接默认长期有效

🚀 **使用流程：**

1️⃣ **获取Token** (10分钟有效)
   • 发送 \`/gettoken\` 命令
   • 24小时内最多生成2次

2️⃣ **兑换链接** (10分钟内兑换)
   • 将token发送给机器人
   • 获得播放列表链接

3️⃣ **长期使用**
   • 链接默认长期有效
   • 5小时内刷新不超过6次

📋 **可用命令：**
• \`/gettoken\` - 获取访问token
• \`/mycredentials\` - 查看我的凭据
• \`/revoke\` - 撤销我的访问权限
• \`/help\` - 显示帮助信息

⚠️ **重要规则：**
• Token必须在10分钟内兑换，否则失效
• 24小时内最多生成2个token
• 播放列表5小时内刷新超过6次将失效
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

您在24小时内已生成了 ${limitCheck.count}/${limitCheck.maxCount} 个token。

⏰ **重置时间：** ${limitCheck.remainingTime} 分钟后

🔄 **解决方案：**
1. 等待 ${limitCheck.remainingTime} 分钟后重试
2. 或使用 \`/revoke\` 撤销现有凭据后重新生成

💡 **提示：** 为避免频繁生成token，请在10分钟内及时兑换。
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
2. 或等待现有token过期（10分钟）
3. 或使用 \`/revoke\` 命令清理现有凭据

💡 **提示：** 请在10分钟内使用token兑换播放列表。
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
📊 **生成统计：** ${limitCheck2.count}/${limitCheck2.maxCount} (24小时内)

📝 **下一步：**
请在10分钟内将此token直接发送给机器人兑换播放列表。

⚠️ **重要提醒：**
• 此token只能使用一次
• 必须在10分钟内兑换，否则失效
• 不要分享给他人
• 兑换后的播放列表长期有效
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
            
            // 获取当前token生成限制信息
            const limitCheck = this.checkTokenGenerationLimit(userId);
            
            // 生成播放链接 - 只保留M3U Plus链接
            const serverUrl = this.getServerUrl();
            const m3uLink = `${serverUrl}/get.php?username=${credentials.username}&password=${credentials.password}&type=m3u_plus`;
            
            const credentialsMessage = `
🎉 **恭喜！您的IPTV播放列表已生成**

📺 **基本信息：**
🌐 服务器地址: \`${serverUrl}\`
👤 用户名: \`${credentials.username}\`
🔐 密码: \`${credentials.password}\`
🔗 最大连接数: ${credentials.maxConnections}

📱 **播放列表链接：**

🎬 **M3U Plus播放列表**:
\`${m3uLink}\`

✨ **重要特性：**
• 🔐 **加密保护** - 链接已加密，无法直接复制频道
• ⏰ **长期有效** - 默认长期有效，无需频繁更新
• 📱 **多设备支持** - 最多3台设备同时使用
• 🛡️ **智能管理** - 5小时内刷新超过6次将自动失效

📖 **使用方法：**

**方法1 - 直接导入播放列表：**
1. 复制上面的M3U Plus链接
2. 在IPTV播放器中选择"添加播放列表"
3. 粘贴链接即可

**方法2 - Xtream Codes配置：**
1. 在IPTV播放器中选择"Xtream Codes"
2. 服务器: \`${serverUrl}\`
3. 用户名: \`${credentials.username}\`
4. 密码: \`${credentials.password}\`

⚠️ **使用提醒：**
• 链接默认长期有效，请妥善保管
• 避免在5小时内刷新超过6次
• 不要与他人分享您的凭据
• 最多支持3台设备同时使用

🎯 **下次获取：** 24小时内还可以生成 ${2 - (limitCheck.count || 1)} 次token
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

您还没有生成IPTV播放列表。

🔄 **获取播放列表：**
1. 发送 \`/gettoken\` 获取访问token
2. 将收到的token发送给机器人
3. 获得您的专属IPTV播放列表

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
        
        // 生成播放链接 - 只保留M3U Plus链接
        const serverUrl = this.getServerUrl();
        const m3uLink = `${serverUrl}/get.php?username=${credentials.username}&password=${credentials.password}&type=m3u_plus`;
        
        const credentialsMessage = `
📺 **您的IPTV播放列表凭据**

🌐 **服务器地址：** \`${serverUrl}\`
👤 **用户名：** \`${credentials.username}\`
🔐 **密码：** \`${credentials.password}\`
🔗 **最大连接数：** ${credentials.maxConnections}

📱 **播放列表链接：**

🎬 **M3U Plus播放列表**:
\`${m3uLink}\`

✨ **链接特性：**
• 🔐 加密保护，无法直接复制频道链接
• ⏰ 默认长期有效
• 📱 最多支持3台设备同时使用
• 🛡️ 5小时内刷新超过6次将失效

📖 **使用方法：**
**直接导入播放列表：**
1. 复制M3U Plus链接
2. 在IPTV播放器中导入
3. 或使用Xtream Codes配置

💡 **使用建议：**
• 避免频繁刷新播放列表
• 合理分配多设备使用
• 妥善保管凭据信息

🔄 **管理命令：**
• \`/revoke\` - 撤销当前凭据
• \`/gettoken\` - 重新生成token
• \`/revoke\` - 撤销访问权限
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

您还没有生成过IPTV播放列表。

🔄 **获取播放列表：**
1. 发送 \`/gettoken\` 获取访问token
2. 将收到的token发送给机器人
3. 获得您的专属IPTV播放列表

需要帮助请发送 \`/help\` 查看详细指南。
        `, { parse_mode: 'Markdown' });
            return;
        }
        
        try {
            // 撤销用户访问权限
            await this.revokeUserAccess(userId, '用户主动撤销访问权限', false);
            
            await this.bot.sendMessage(chatId, `
✅ **访问权限已撤销**

您的IPTV播放列表已被成功撤销，所有相关链接已失效。

🔄 **重新获取访问权限：**
1. 发送 \`/gettoken\` 命令获取新token
2. 将新token发送给机器人
3. 获得新的播放列表链接

💡 **提示：**
• 新播放列表将重置所有使用统计
• 播放列表请求计数重新开始
• 旧的播放列表链接将完全失效
• 您的永久用户状态（如有）将被保留

🌟 **重新开始的好处：**
• 清理所有旧的播放列表
• 重置使用限制计数
• 获得全新的加密链接

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
        const isAdmin = this.isAdmin(userId); // 使用新的验证方法
        
        if (isPrivateChat) {
            // 私聊中的帮助信息
            let helpMessage = '';
            
            if (isAdmin) {
                // 管理员看到管理员命令优先
                helpMessage = `
🔧 **管理员专用命令**

🛠️ **服务器管理：**
• \`/refresh\` - 手动刷新原始服务器
• \`/admin stats\` - 查看系统统计
• \`/admin list\` - 查看所有用户
• \`/admin cleanup\` - 清理过期数据
• \`/admin backup\` - 备份用户数据
• \`/admin restore\` - 恢复用户数据
• \`/admin delete <用户名>\` - 删除指定用户
• \`/admin delete_id <Telegram用户ID>\` - 按ID删除用户

📊 **监控命令：**
• \`/status\` - 查看服务器状态

---

🤖 **普通用户命令**

📋 **基本功能：**
• \`/gettoken\` - 获取访问token
• \`/mycredentials\` - 查看我的凭据
• \`/revoke\` - 撤销访问权限
• \`/help\` - 显示此帮助信息

📖 **使用流程：**

1️⃣ **获取Token**
   • 发送 \`/gettoken\` 命令
   • Token有效期：10分钟
   • 24小时内限制生成2次

2️⃣ **兑换凭据**
   • 将收到的token直接发送给机器人
   • 获得专属IPTV播放列表
   • 链接默认长期有效

3️⃣ **使用播放列表**
   • 复制M3U Plus链接到IPTV播放器
   • 或使用Xtream Codes配置方式

⚠️ **重要说明：**
• Token有效期10分钟，过期需重新生成
• 链接5小时内刷新超过6次将失效
• 每个用户最多3台设备同时使用
• 必须保持群组成员身份

💡 **推荐IPTV播放器：**
• IPTV Smarters Pro
• TiviMate
• Perfect Player
• GSE Smart IPTV

如需技术支持，请联系管理员。
            `;
            } else {
                // 普通用户帮助信息
                helpMessage = `
🤖 **智能IPTV播放列表机器人使用指南**

📋 **可用命令：**

🎫 \`/gettoken\` - 获取访问token
📺 \`/mycredentials\` - 查看我的凭据
🚫 \`/revoke\` - 撤销访问权限
❓ \`/help\` - 显示此帮助信息

📖 **详细使用流程：**

1️⃣ **获取Token**
   • 发送 \`/gettoken\` 命令
   • Token有效期：10分钟
   • 24小时内限制生成2次

2️⃣ **兑换凭据**
   • 将收到的token直接发送给机器人
   • 获得专属IPTV播放列表
   • 链接默认长期有效

3️⃣ **使用播放列表**
   • 复制M3U Plus链接到IPTV播放器
   • 或使用Xtream Codes配置方式

⚠️ **重要说明：**
• Token有效期10分钟，过期需重新生成
• 链接5小时内刷新超过6次将失效
• 每个用户最多3台设备同时使用
• 必须保持群组成员身份

💡 **推荐IPTV播放器：**
• IPTV Smarters Pro
• TiviMate
• Perfect Player
• GSE Smart IPTV

如需技术支持，请联系管理员。
            `;
            }
            
            await this.bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
            
        } else if (isInGroup) {
            // 群组中的简化帮助信息
            await this.bot.sendMessage(chatId, `
📺 **IPTV播放列表机器人**

🔒 请私聊机器人获取详细使用帮助和IPTV播放列表。

💬 **快速开始：**
1. 点击 [@${this.bot.options.username || 'bot'}](https://t.me/${this.bot.options.username || 'bot'}) 私聊机器人
2. 发送 \`/gettoken\` 获取访问token
3. 使用收到的token获取播放列表

⚠️ **注意：** 必须是本群组成员才能使用服务。
        `, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        }
    }
    
    async handleAdminCommand(msg, command) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // 只在私聊中处理
        if (msg.chat.type !== 'private') {
            await this.bot.sendMessage(chatId, '🔒 请私聊机器人使用管理员命令。');
            return;
        }
        
        // 验证管理员权限
        if (!this.isAdmin(userId)) {
            await this.bot.sendMessage(chatId, '❌ 此命令仅限管理员使用。');
            return;
        }
        
        // 解析命令和参数
        const parts = command.trim().split(/\s+/);
        const mainCommand = parts[0].toLowerCase();
        const args = parts.slice(1);
        
        try {
            switch (mainCommand) {
                case 'statistics':
                    await this.handleAdminStats(chatId);
                    break;
                    
                case 'list':
                    await this.handleAdminList(chatId);
                    break;
                    
                case 'cleanup':
                case 'clean':
                    await this.handleAdminCleanup(chatId);
                    break;
                    
                case 'backup':
                    await this.handleAdminBackup(chatId);
                    break;
                    
                case 'restore':
                    await this.handleAdminRestore(chatId);
                    break;
                    
                case 'delete':
                    if (args.length > 0) {
                        await this.handleAdminDeleteUser(chatId, args[0]);
                    } else {
                        await this.bot.sendMessage(chatId, '❌ 请指定要删除的用户名。\n用法: `/admin delete <用户名>`', { parse_mode: 'Markdown' });
                    }
                    break;
                    
                case 'delete_id':
                    if (args.length > 0) {
                        await this.handleAdminDeleteUserById(chatId, args[0]);
                    } else {
                        await this.bot.sendMessage(chatId, '❌ 请指定要删除的Telegram用户ID。\n用法: `/admin delete_id <用户ID>`', { parse_mode: 'Markdown' });
                    }
                    break;
                    
                case 'refresh':
                    await this.handleRefreshCommand(msg);
                    break;
                    
                case 'help':
                case '':
                    await this.handleAdminPanel(msg);
                    break;
                    
                default:
                    await this.bot.sendMessage(chatId, `
❌ **未知的管理员命令: ${mainCommand}**

🛠️ **可用的管理员命令：**
• \`statistics\` - 查看系统统计
• \`list\` - 查看用户列表  
• \`cleanup\` - 清理过期数据
• \`backup\` - 备份数据
• \`restore\` - 恢复数据
• \`delete <用户名>\` - 删除用户
• \`delete_id <用户ID>\` - 按ID删除用户
• \`refresh\` - 刷新服务器

或发送 \`/admin\` 查看完整管理面板。
                    `, { parse_mode: 'Markdown' });
                    break;
            }
        } catch (error) {
            console.error(`Error executing admin command ${mainCommand}:`, error);
            await this.bot.sendMessage(chatId, `❌ 执行管理员命令时发生错误: ${error.message}`);
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
        const maxTokensPerPeriod = this.config.maxTokensPerUser || 2; // 24小时内最多2个
        const limitPeriod = this.config.tokenGenerationPeriod || 86400000; // 24小时
        
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
        const limitPeriod = this.config.tokenGenerationPeriod || 86400000; // 24小时
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
    
    // 新增：用户状态查看命令
    async handleStatusCommand(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // 只在私聊中处理
        if (msg.chat.type !== 'private') {
            await this.bot.sendMessage(chatId, '🔒 请私聊机器人查看您的状态信息。');
            return;
        }
        
        const credentials = this.userCredentials.get(userId);
        
        if (!credentials) {
            await this.bot.sendMessage(chatId, `
❌ **没有找到凭据**

您还没有生成IPTV播放列表。

🔄 **获取播放列表：**
1. 发送 \`/gettoken\` 获取访问token
2. 将收到的token发送给机器人
3. 获得您的专属IPTV播放列表

需要帮助请发送 \`/help\` 查看详细指南。
        `, { parse_mode: 'Markdown' });
            return;
        }
        
        // 获取用户在服务器端的状态信息
        try {
            const serverUrl = this.getServerUrl();
            const response = await axios.get(`${serverUrl}/api/user-status?username=${credentials.username}`, {
                timeout: 5000
            }).catch(() => null);
            
            let userStatus = {
                activePlaylists: 0,
                requestsUsed: 0,
                requestsRemaining: 5,
                totalRequests: 0
            };
            
            if (response && response.data) {
                userStatus = response.data;
            }
            
            // 获取token生成限制信息
            const limitCheck = this.checkTokenGenerationLimit(userId);
            
            const statusMessage = `
📊 **您的使用状态**

👤 **用户信息：**
• 用户名: \`${credentials.username}\`
• 注册时间: ${new Date(credentials.createdAt).toLocaleString('zh-CN')}
• 用户等级: 📺 **IPTV用户**

📱 **播放列表状态：**
• 当前活跃播放列表: ${userStatus.activePlaylists}/3
• 5小时内请求次数: ${userStatus.requestsUsed}/6
• 剩余请求次数: ${6 - userStatus.requestsUsed}
• 历史总请求: ${userStatus.totalRequests}

✨ **用户特权：**
• 🌟 播放列表默认长期有效
• 📱 最多3台设备同时使用
• 🔐 加密链接保护
• ⚡ 智能限制管理

⏳ **使用限制：**
• 📊 5小时内最多刷新6次
• 🎯 超过6次刷新将暂时失效
• 🔄 24小时内最多生成${this.config.telegram?.maxTokensPerUser || 2}次token

🎯 **Token状态：**
• 今日已生成: ${limitCheck.count || 0}/${this.config.telegram?.maxTokensPerUser || 2} 次
• 重置时间: ${limitCheck.resetTime ? new Date(limitCheck.resetTime).toLocaleString('zh-CN') : '暂无'}

🔄 **管理命令：**
• \`/mycredentials\` - 查看凭据信息
• \`/gettoken\` - 重新生成token
• \`/revoke\` - 撤销访问权限
        `;
            
            await this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
            
        } catch (error) {
            console.error('Error fetching user status:', error);
            await this.bot.sendMessage(chatId, '❌ 获取状态信息时发生错误，请稍后重试。');
        }
    }
    
    // 新增：处理管理员面板命令
    async handleAdminPanel(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // 只在私聊中处理
        if (msg.chat.type !== 'private') {
            await this.bot.sendMessage(chatId, '🔒 请私聊机器人使用管理员命令。');
            return;
        }
        
        // 验证管理员权限
        if (!this.isAdmin(userId)) {
            await this.bot.sendMessage(chatId, '❌ 此命令仅限管理员使用。');
            return;
        }
        
        const adminPanelMessage = `
🛠️ **管理员控制面板**

📊 **系统管理：**
• \`/refresh\` - 手动刷新原始服务器
• \`/admin stats\` - 查看系统统计信息
• \`/admin list\` - 查看所有用户列表
• \`/admin cleanup\` - 清理过期数据

👥 **用户管理：**
• \`/admin delete <用户名>\` - 删除指定用户
• \`/admin delete_id <Telegram用户ID>\` - 按ID删除用户

👑 **管理员管理：**
• \`/addadmin <用户ID>\` - 添加新管理员
• \`/removeadmin <用户ID>\` - 移除管理员
• \`/listadmins\` - 查看管理员列表

💾 **数据管理：**
• \`/admin backup\` - 备份用户数据
• \`/admin restore\` - 恢复用户数据

🔄 **快捷命令：**
直接发送以下命令：
• \`/refresh\` - 快速刷新服务器

💡 **当前状态：**
• 当前管理员: ${this.getAllAdminIds().length} 人
• 您的ID: \`${userId}\`
• 服务器运行正常 ✅
• 自动刷新: ${this.config.originalServer?.enableAutoRefresh ? '已启用' : '已禁用'}
    `;
        
        await this.bot.sendMessage(chatId, adminPanelMessage, { parse_mode: 'Markdown' });
    }
    
    // 新增：处理管理员刷新命令
    async handleRefreshCommand(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // 只在私聊中处理
        if (msg.chat.type !== 'private') {
            await this.bot.sendMessage(chatId, '🔒 请私聊机器人使用此命令。');
            return;
        }
        
        // 验证管理员权限
        if (!this.isAdmin(userId)) {
            await this.bot.sendMessage(chatId, '❌ 此命令仅限管理员使用。');
            return;
        }
        
        try {
            await this.bot.sendMessage(chatId, '🔄 正在手动刷新原始服务器，请稍候...');
            
            // 调用服务器刷新方法
            const result = await this.userManager.refreshOriginalServer();
            
            if (result.success) {
                // 简化消息，只显示基本统计信息
                const successMessage = `✅ 原始服务器刷新成功

📊 已加载 ${result.channelCount} 个频道，共 ${result.categoryCount} 个分类
⏰ 刷新时间: ${result.refreshTime}`;
                
                await this.bot.sendMessage(chatId, successMessage);
                
            } else {
                const errorMessage = `❌ 原始服务器刷新失败

错误信息: ${result.error}
失败时间: ${result.refreshTime}`;
                
                await this.bot.sendMessage(chatId, errorMessage);
            }
            
        } catch (error) {
            console.error('Error handling refresh command:', error);
            await this.bot.sendMessage(chatId, `❌ 执行刷新命令时发生错误：${error.message}`);
        }
    }
    
    // 新增：处理检查管理员状态命令（调试用）
    async handleCheckAdminCommand(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (msg.chat.type !== 'private') {
            return;
        }
        
        const isAdmin = this.isAdmin(userId);
        const adminIds = this.getAllAdminIds();
        
        const checkMessage = `
🔍 **管理员身份检测**

👤 **您的信息：**
• 用户ID: \`${userId}\`
• 是否为管理员: ${isAdmin ? '✅ 是' : '❌ 否'}

📋 **系统管理员列表：**
${adminIds.map((id, index) => `${index + 1}. \`${id}\` ${id === userId.toString() ? '👤 (您)' : ''}`).join('\n')}

⚙️ **配置信息：**
• 管理员总数: ${adminIds.length}
• 旧格式管理员: ${this.config.adminUserId || '未设置'}
• 新格式管理员: ${this.config.adminUserIds ? this.config.adminUserIds.join(', ') : '未设置'}

${isAdmin ? 
    '✅ 您拥有管理员权限，可以使用所有管理员命令。' : 
    '❌ 您没有管理员权限，只能使用普通用户命令。'
}
    `;
        
        await this.bot.sendMessage(chatId, checkMessage, { parse_mode: 'Markdown' });
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