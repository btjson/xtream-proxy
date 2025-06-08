class AdminHandler {
    constructor(config, userManager, logger) {
        this.config = config;
        this.userManager = userManager;
        this.logger = logger;
    }
    
    async handleAdminCommand(msg, bot, args) {
        if (args.length === 0) {
            await this.showAdminHelp(msg, bot);
            return;
        }
        
        const subCommand = args[0].toLowerCase();
        
        switch (subCommand) {
            case 'stats':
                await this.handleStats(msg, bot);
                break;
            case 'users':
                await this.handleUsersList(msg, bot);
                break;
            case 'cleanup':
                await this.handleCleanup(msg, bot);
                break;
            case 'changem3u':
                await this.handleChangeM3U(msg, bot, args.slice(1));
                break;
            default:
                await this.showAdminHelp(msg, bot);
        }
    }
    
    async showAdminHelp(msg, bot) {
        const help = `🔧 管理员命令帮助：

• /admin stats - 查看系统统计
• /admin users - 查看用户列表
• /admin cleanup - 清理过期数据
• /changem3u <新的M3U链接> - 修改M3U订阅链接

使用示例：
• /admin stats
• /changem3u https://example.com/playlist.m3u`;
        
        await bot.sendMessage(msg.chat.id, help);
    }
    
    async handleStats(msg, bot) {
        const users = this.userManager.getUsers();
        const activeUsers = Object.values(users).filter(user => user.enabled).length;
        const telegramUsers = Object.values(users).filter(user => user.source === 'telegram').length;
        
        const stats = `📊 系统统计：

👥 *用户统计*
• 总用户数：${Object.keys(users).length}
• 活跃用户：${activeUsers}
• Telegram用户：${telegramUsers}

🖥️ *系统信息*
• 运行时间：${Math.floor(process.uptime() / 3600)} 小时
• 内存使用：${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB
• Node.js版本：${process.version}

✅ 系统运行正常`;
        
        await bot.sendMessage(msg.chat.id, stats, { parse_mode: 'Markdown' });
    }
    
    async handleUsersList(msg, bot) {
        const users = this.userManager.getUsers();
        
        if (Object.keys(users).length === 0) {
            await bot.sendMessage(msg.chat.id, '📝 当前没有用户');
            return;
        }
        
        let message = '👥 用户列表：\n\n';
        
        for (const [username, user] of Object.entries(users)) {
            const status = user.enabled ? '✅' : '❌';
            const source = user.source === 'telegram' ? '🤖' : '⚙️';
            const createdDate = new Date(user.createdAt).toLocaleDateString();
            
            message += `${status} ${source} \`${username}\`\n`;
            message += `   创建：${createdDate}\n\n`;
        }
        
        // 分割长消息
        if (message.length > 4000) {
            const chunks = this.splitMessage(message, 4000);
            for (const chunk of chunks) {
                await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' });
            }
        } else {
            await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
        }
    }
    
    async handleCleanup(msg, bot) {
        await bot.sendMessage(msg.chat.id, '🧹 正在清理过期数据...');
        
        try {
            // 这里可以调用各种清理方法
            this.userManager.cleanup();
            
            await bot.sendMessage(msg.chat.id, '✅ 数据清理完成');
        } catch (error) {
            await bot.sendMessage(msg.chat.id, `❌ 清理失败：${error.message}`);
        }
    }
    
    async handleChangeM3U(msg, bot, args) {
        if (args.length === 0) {
            const currentUrl = this.config.originalServer?.url || '未设置';
            const channelCount = this.userManager.channelManager ? 
                this.userManager.channelManager.getChannelCount() : 0;
            
            await bot.sendMessage(msg.chat.id, `📺 **当前M3U订阅链接管理：**

🔗 **当前链接**：
\`${currentUrl}\`

📊 **当前状态**：
• **频道数量**：${channelCount}
• **链接状态**：${currentUrl !== '未设置' ? '✅ 已配置' : '❌ 未配置'}

💡 **使用方法**：
\`/changem3u <新的M3U链接>\`

📝 **示例**：
\`/changem3u https://example.com/playlist.m3u\`

⚠️ **注意**：修改后将自动刷新频道列表并更新所有用户的播放列表`, { parse_mode: 'Markdown' });
            return;
        }

        const newUrl = args.join(' ').trim();
        
        // 验证URL格式
        if (!this.isValidUrl(newUrl)) {
            await bot.sendMessage(msg.chat.id, `❌ **无效的URL格式**

请提供有效的HTTP/HTTPS链接，例如：
\`https://example.com/playlist.m3u\``, { parse_mode: 'Markdown' });
            return;
        }

        const oldUrl = this.config.originalServer?.url || '未设置';
        
        try {
            await bot.sendMessage(msg.chat.id, `🔄 **正在更新M3U订阅链接...**

📡 **旧链接**：\`${oldUrl}\`
🆕 **新链接**：\`${newUrl}\`

请稍候，正在测试新链接并刷新频道列表...`, { parse_mode: 'Markdown' });

            // 更新配置
            await this.updateM3UUrl(newUrl);
            
            // 更新ChannelManager的配置引用
            if (this.userManager.channelManager && this.userManager.channelManager.updateConfig) {
                this.userManager.channelManager.updateConfig(this.config);
            }
            
            // 刷新频道列表
            if (this.userManager.channelManager && this.userManager.channelManager.refreshChannels) {
                await this.userManager.channelManager.refreshChannels();
                
                const channelCount = this.userManager.channelManager.getChannelCount ? 
                    this.userManager.channelManager.getChannelCount() : '未知';
                
                await bot.sendMessage(msg.chat.id, `✅ **M3U订阅链接更新成功！**

📺 **新链接**：\`${newUrl}\`
🔄 **频道列表已自动刷新**
📊 **当前频道数量**：${channelCount}

💡 **重要提醒**：所有用户需要重新获取播放列表才能看到更新的频道。`, { parse_mode: 'Markdown' });
                
                this.logger.info(`管理员 ${msg.from.id} 更新了M3U链接: ${oldUrl} -> ${newUrl}`);
            } else {
                await bot.sendMessage(msg.chat.id, `✅ **M3U订阅链接已更新！**

📺 **新链接**：\`${newUrl}\`

⚠️ **警告**：频道管理器不可用，请手动刷新频道列表。`, { parse_mode: 'Markdown' });
            }
            
        } catch (error) {
            this.logger.error('更新M3U链接失败:', error);
            await bot.sendMessage(msg.chat.id, `❌ **更新M3U链接失败：**

**错误信息**：${error.message}

**可能的原因**：
• 新链接无法访问
• 链接格式不正确
• 网络连接问题

**解决方案**：请检查链接是否有效后重试。`, { parse_mode: 'Markdown' });
        }
    }

    isValidUrl(string) {
        try {
            const url = new URL(string);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    async updateM3UUrl(newUrl) {
        // 更新内存中的配置
        if (!this.config.originalServer) {
            this.config.originalServer = {};
        }
        this.config.originalServer.url = newUrl;
        
        // 保存配置到文件并重新加载
        const ConfigManager = require('../../utils/ConfigManager');
        const configManager = new ConfigManager();
        configManager.set('originalServer.url', newUrl);
        
        // 重新加载配置以确保所有引用都更新
        const updatedConfig = configManager.getConfig();
        
        // 更新当前配置引用
        Object.assign(this.config, updatedConfig);
        
        this.logger.info(`M3U URL updated to: ${newUrl}`);
    }
    
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
            currentChunk += line + '\n';
        }
        
        if (currentChunk) {
            chunks.push(currentChunk);
        }
        
        return chunks;
    }
}

module.exports = AdminHandler; 