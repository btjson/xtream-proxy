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
            default:
                await this.showAdminHelp(msg, bot);
        }
    }
    
    async showAdminHelp(msg, bot) {
        const help = `🔧 管理员命令帮助：

• /admin stats - 查看系统统计
• /admin users - 查看用户列表
• /admin cleanup - 清理过期数据

使用示例：/admin stats`;
        
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