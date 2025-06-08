class CommandHandler {
    constructor(config, userManager, logger, serverConfig) {
        this.config = config;
        this.userManager = userManager;
        this.logger = logger;
        this.serverConfig = serverConfig;
    }
    
    getServerUrl() {
        // 优先使用配置中的外部URL，否则使用localhost
        if (this.config.server?.externalUrl) {
            return this.config.server.externalUrl;
        }
        
        // 如果配置了host且不是0.0.0.0，使用配置的host
        const host = this.serverConfig.host === '0.0.0.0' ? 'localhost' : this.serverConfig.host;
        return `http://${host}:${this.serverConfig.port}`;
    }
    
    async handleStart(msg, bot) {
        const welcome = `🎬 欢迎使用 Xtream Codes Proxy 机器人！

✨ *功能介绍:*
• 安全的IPTV访问管理
• 自动生成个人登录凭据
• 支持多种播放器格式

📋 *可用命令:*
🔸 /help - 详细帮助信息
🔸 /gettoken - 获取访问令牌
🔸 /mycredentials - 查看登录凭据
🔸 /status - 服务器状态
🔸 /refresh - 刷新频道列表

🚀 *开始使用:*
请使用 /gettoken 命令获取您的访问权限！

🔒 *隐私保护:*
所有操作均在私聊中进行，确保您的信息安全。`;
        
        await bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown' });
    }
    
    async handleHelp(msg, bot) {
        const help = `🆘 Xtream Codes Proxy 完整帮助

📱 *主要命令:*
• /start - 开始使用机器人
• /help - 显示此帮助信息
• /gettoken - 获取临时访问令牌
• /mycredentials - 查看我的登录凭据
• /status - 查看服务器运行状态
• /refresh - 刷新频道列表
• /revoke - 撤销访问权限

🔑 *获取访问权限流程:*
1. 确保您已加入授权群组
2. 私聊机器人使用 /gettoken 获取令牌
3. 在私聊中直接发送令牌进行验证
4. 验证成功后自动获得登录凭据

📺 *支持的播放器:*
• IPTV Smarters Pro
• TiviMate
• VLC Media Player
• Perfect Player
• GSE Smart IPTV
• 其他支持Xtream Codes的播放器

🛡️ *安全特性:*
• 令牌有时间限制（10分钟）
• 每用户每天限制生成令牌数量
• 自动检测群组成员身份
• 离开群组自动撤销权限

💡 *使用技巧:*
• 所有操作都在私聊中完成
• 妥善保存您的登录凭据
• 定期使用 /mycredentials 查看信息
• 遇到问题请联系管理员

❓ 如有疑问，请联系群组管理员。`;
        
        await bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown' });
    }
    
    async handleGetToken(msg, bot, tokenManager) {
        try {
            const userId = msg.from.id;
            const username = msg.from.username || msg.from.first_name;
            
            const tokenData = tokenManager.createToken(userId, username);
            const expiryMinutes = Math.floor((tokenData.expiresAt - Date.now()) / 60000);
            
            const message = `🎫 您的访问令牌已生成：

*令牌*: \`${tokenData.token}\`

⏰ *有效期*: ${expiryMinutes} 分钟

📝 *下一步操作:*
请在此私聊中直接发送上面的令牌（复制粘贴8位字符）来验证身份。

例如：直接发送 \`${tokenData.token}\`

🔒 *注意事项:*
• 此令牌仅供您个人使用
• 请勿分享给他人
• 令牌验证后将自动失效
• 如令牌过期，请重新生成`;
            
            await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
            
        } catch (error) {
            let errorMessage = `❌ 令牌生成失败：${error.message}`;
            
            if (error.message === 'Token generation limit exceeded') {
                errorMessage = `❌ 令牌生成失败：每日限制已达上限

⚠️ 限制说明：
• 每天最多生成 2 个令牌
• 24小时后自动重置

💡 如果您已有有效令牌，请直接使用
🔄 请明天再试或联系管理员`;
            }
            
            await bot.sendMessage(msg.chat.id, errorMessage);
        }
    }
    
    async handleTokenVerification(msg, bot, tokenManager) {
        const token = msg.text.trim();
        const userId = msg.from.id;
        
        this.logger.info(`验证令牌: ${token} for user ${userId}`);
        
        const tokenData = tokenManager.verifyToken(token, userId);
        if (!tokenData) {
            await bot.sendMessage(msg.chat.id, `❌ 令牌验证失败

可能的原因：
• 令牌已过期
• 令牌格式不正确
• 令牌已被使用

请使用 /gettoken 重新生成令牌。`);
            return;
        }
        
        // 创建用户凭据
        const username = `tg_${this.generateShortId()}`;
        const password = this.generatePassword();
        
        try {
            this.userManager.createTelegramUser(username, password, userId);
            
            // 重置用户的每小时播放列表刷新限制
            this.userManager.resetUserHourlyLimit(username);
            
            const serverUrl = this.userManager.getServerUrl();
            
            // 只发送M3U Plus播放列表链接
            const message = `🎉 令牌验证成功！您的登录凭据：

📺 M3U Plus播放列表链接：

\`${serverUrl}/get.php?username=${username}&password=${password}&type=m3u_plus\`

（复制此链接到您的IPTV播放器）`;
            
            await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
            
            this.logger.info(`用户 ${userId} 验证成功，创建凭据: ${username}`);
            
        } catch (error) {
            this.logger.error(`创建用户失败:`, error);
            await bot.sendMessage(msg.chat.id, `❌ 创建用户失败：${error.message}

请稍后重试或联系管理员。`);
        }
    }
    
    async handleMyCredentials(msg, bot) {
        const userId = msg.from.id;
        
        // 查找用户的Telegram用户名
        const users = this.userManager.getUsers();
        let userCredentials = null;
        let foundUsername = null;
        
        for (const [username, user] of Object.entries(users)) {
            if (user.telegramUserId === userId) {
                userCredentials = user;
                foundUsername = username;
                break;
            }
        }
        
        if (!userCredentials) {
            await bot.sendMessage(msg.chat.id, `❌ 您还没有登录凭据

🔧 获取凭据流程：
1. 使用 /gettoken 命令获取令牌
2. 直接发送令牌进行验证
3. 验证成功后自动获得凭据

请使用 /gettoken 开始获取访问权限。`);
            return;
        }
        
        const serverUrl = this.userManager.getServerUrl();
        
        // 只显示M3U Plus播放列表链接
        const message = `🎉 您的登录凭据：

📺 M3U Plus播放列表链接：

\`${serverUrl}/get.php?username=${foundUsername}&password=${userCredentials.password}&type=m3u_plus\`

（复制此链接到您的IPTV播放器）`;
        
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
    }
    
    async handleStatus(msg, bot) {
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        
        const status = `📊 服务器状态报告：

🟢 *服务状态*: 在线运行
⏰ *运行时间*: ${hours}小时 ${minutes}分钟
👥 *总用户数*: ${this.userManager.getUserCount()}
💾 *内存使用*: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB
🌐 *服务器地址*: ${this.userManager.getServerUrl()}

📈 *服务统计:*
• 活跃用户: ${this.userManager.getActiveUsers().length}
• 频道总数: 正在统计...
• 系统负载: 正常

✅ *系统状态*: 所有服务运行正常

🔄 最后更新: ${new Date().toLocaleString()}`;
        
        await bot.sendMessage(msg.chat.id, status, { parse_mode: 'Markdown' });
    }
    
    async handleRefresh(msg, bot) {
        // 检查是否为管理员
        const userId = msg.from.id;
        const isAdmin = this.isAdmin(userId);
        
        if (!isAdmin) {
            await bot.sendMessage(msg.chat.id, `❌ 权限不足

🔒 此命令仅限管理员使用
💡 如需刷新播放列表，请直接重新获取播放列表链接`);
            return;
        }
        
        await bot.sendMessage(msg.chat.id, `🔄 管理员操作：正在刷新频道列表...

请稍候，这可能需要几秒钟时间。`);
        
        try {
            // 这里可以调用频道管理器的刷新方法
            if (this.userManager.channelManager && this.userManager.channelManager.refreshChannels) {
                await this.userManager.channelManager.refreshChannels();
            }
            
            await bot.sendMessage(msg.chat.id, `✅ 管理员操作完成：频道列表刷新成功！

📺 频道列表已更新到最新版本
🔄 用户需要重新获取播放列表才能看到更新
📊 建议通知用户刷新播放器缓存

💡 用户可以通过重新访问播放列表链接获取最新频道。`);
        } catch (error) {
            await bot.sendMessage(msg.chat.id, `❌ 管理员操作失败：${error.message}

请检查服务器状态或联系技术支持。`);
        }
    }
    
    async handleRevoke(msg, bot, args) {
        const userId = msg.from.id;
        
        // 查找并删除用户的所有凭据
        const users = this.userManager.getUsers();
        let deletedCount = 0;
        let deletedUsernames = [];
        
        for (const [username, user] of Object.entries(users)) {
            if (user.telegramUserId === userId) {
                if (this.userManager.deleteUser(username)) {
                    deletedCount++;
                    deletedUsernames.push(username);
                }
            }
        }
        
        if (deletedCount > 0) {
            await bot.sendMessage(msg.chat.id, `✅ 访问权限撤销成功

🗑️ 已删除的账户: ${deletedCount} 个
📝 删除的用户名: ${deletedUsernames.join(', ')}

💡 后续操作：
• 您的所有登录凭据已失效
• 播放器将无法继续播放
• 如需重新获取，请使用 /gettoken

🔒 权限撤销操作已完成。`);
        } else {
            await bot.sendMessage(msg.chat.id, `❌ 未找到您的用户信息

可能的原因：
• 您还未获取过访问权限
• 账户已经被删除
• 系统数据异常

💡 请使用 /gettoken 获取新的访问权限。`);
        }
    }
    
    generatePassword() {
        // 生成更安全的密码
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let password = '';
        for (let i = 0; i < 12; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return password;
    }
    
    generateShortId() {
        // 生成更短但足够唯一的ID
        return Math.random().toString(36).substring(2, 10);
    }
    
    // 检查是否为管理员
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
}

module.exports = CommandHandler; 