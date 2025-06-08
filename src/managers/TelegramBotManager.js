const TelegramBot = require('node-telegram-bot-api');
const TokenManager = require('./telegram/TokenManager');
const CommandHandler = require('./telegram/CommandHandler');
const AdminHandler = require('./telegram/AdminHandler');
const UserValidator = require('./telegram/UserValidator');

class TelegramBotManager {
    constructor(config, userManager, logger) {
        this.config = config.telegram;
        this.serverConfig = config.server;
        this.userManager = userManager;
        this.logger = logger;
        
        this.bot = null;
        this.isShuttingDown = false;
        
        // 初始化子管理器
        this.tokenManager = new TokenManager(this.config, this.logger);
        this.userValidator = new UserValidator(this.config, this.logger);
        this.commandHandler = new CommandHandler(this.config, this.userManager, this.logger, this.serverConfig);
        this.adminHandler = new AdminHandler(this.config, this.userManager, this.logger);
        
        // 群组成员管理
        this.groupMembers = new Set();
        
        if (config.features.enableTelegramBot && this.config.botToken) {
            this.initializeBot();
        }
    }
    
    async initializeBot() {
        try {
            // 如果已经有机器人实例在运行，先停止它
            if (this.bot) {
                try {
                    await this.bot.stopPolling();
                    this.bot = null;
                } catch (error) {
                    this.logger.warn('停止现有机器人实例时出错:', error.message);
                }
            }

            this.bot = new TelegramBot(this.config.botToken, { 
                polling: {
                    interval: 1000,  // 增加轮询间隔
                    autoStart: false, // 手动启动轮询
                    params: {
                        timeout: 10,
                        allowed_updates: ['message', 'chat_member', 'my_chat_member']
                    }
                },
                filepath: false
            });
            
            await this.setupBotHandlers();
            await this.setupBotCommands();
            
            // 手动启动轮询，并处理冲突错误
            try {
                await this.bot.startPolling();
                this.logger.info('✅ Telegram bot polling started successfully');
            } catch (pollingError) {
                if (pollingError.code === 'ETELEGRAM' && pollingError.response?.body?.error_code === 409) {
                    this.logger.warn('⚠️  检测到机器人冲突，等待其他实例停止...');
                    // 等待一段时间后重试
                    await new Promise(resolve => setTimeout(resolve, 10000));
                    await this.bot.startPolling();
                    this.logger.info('✅ Telegram bot polling restarted after conflict resolution');
                } else {
                    throw pollingError;
                }
            }
            
            // 初始化群组成员列表
            await this.initializeGroupMembers();
            
            this.logger.info('✅ Telegram bot initialized successfully');
            
            // 通知管理员机器人已启动
            await this.notifyAdmins('🤖 Xtream Codes Proxy bot is now online!');
            
        } catch (error) {
            this.logger.error('❌ Failed to initialize Telegram bot:', error.message);
            
            // 如果是409冲突错误，等待更长时间后重试
            if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
                this.logger.info('⏳ 等待30秒后重试初始化机器人...');
                setTimeout(() => {
                    this.initializeBot();
                }, 30000);
            } else {
                // 其他错误，等待5秒后重试
                this.logger.info('⏳ 等待5秒后重试初始化机器人...');
                setTimeout(() => {
                    this.initializeBot();
                }, 5000);
            }
        }
    }

    async initializeGroupMembers() {
        try {
            // 获取群组成员列表
            const chatId = parseInt(this.config.groupId);
            const administrators = await this.bot.getChatAdministrators(chatId);
            
            for (const admin of administrators) {
                this.groupMembers.add(admin.user.id);
            }
            
            this.logger.info(`初始化群组成员: ${this.groupMembers.size} 个成员`);
        } catch (error) {
            this.logger.error('初始化群组成员失败:', error);
        }
    }

    async setupBotCommands() {
        const commands = [
            { command: 'start', description: '开始使用机器人' },
            { command: 'help', description: '显示帮助信息' },
            { command: 'gettoken', description: '获取访问令牌' },
            { command: 'mycredentials', description: '查看我的凭据' },
            { command: 'status', description: '查看服务器状态' },
            { command: 'refresh', description: '刷新频道列表' }
        ];
        
        try {
            await this.bot.setMyCommands(commands);
            this.logger.info('✅ Bot commands set successfully');
        } catch (error) {
            this.logger.error('❌ Failed to set bot commands:', error);
        }
    }
    
    setupBotHandlers() {
        if (!this.bot) return;
        
        // 消息处理
        this.bot.on('message', async (msg) => {
            if (this.isShuttingDown) return;
            
            try {
                await this.handleMessage(msg);
            } catch (error) {
                this.logger.error('Error handling message:', error);
                
                // 尝试发送错误回复
                try {
                    await this.bot.sendMessage(msg.chat.id, '❌ 处理消息时出现内部错误，请稍后重试');
                } catch (sendError) {
                    this.logger.error('Failed to send error response:', sendError);
                }
            }
        });
        
        // 改进的错误处理
        this.bot.on('polling_error', (error) => {
            this.logger.error('Telegram polling error:', error.message);
            
            // 如果是409冲突错误，停止当前轮询并等待重启
            if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
                this.logger.warn('⚠️  检测到机器人冲突，停止轮询并等待重启...');
                
                // 停止轮询
                this.bot.stopPolling().then(() => {
                    this.logger.info('✅ 轮询已停止，等待30秒后重新初始化...');
                    
                    // 等待30秒后重新初始化
                    setTimeout(() => {
                        this.initializeBot();
                    }, 30000);
                }).catch(stopError => {
                    this.logger.error('停止轮询时出错:', stopError.message);
                });
                
                return;
            }
            
            // 如果是网络错误，尝试重启轮询
            if (error.code === 'EFATAL' || error.code === 'EPARSE' || error.code === 'ENOTFOUND') {
                this.logger.info('⏳ 网络错误，5秒后尝试重启轮询...');
                setTimeout(() => {
                    if (this.bot && !this.isShuttingDown) {
                        this.bot.startPolling().catch(restartError => {
                            this.logger.error('重启轮询失败:', restartError.message);
                        });
                    }
                }, 5000);
            }
        });
        
        // 群组成员变化处理
        this.bot.on('chat_member', async (update) => {
            try {
                await this.handleChatMemberUpdate(update);
            } catch (error) {
                this.logger.error('Error handling chat member update:', error);
            }
        });
        
        // 新成员加入
        this.bot.on('new_chat_members', async (msg) => {
            try {
                await this.handleNewChatMembers(msg);
            } catch (error) {
                this.logger.error('Error handling new chat members:', error);
            }
        });
        
        // 成员离开
        this.bot.on('left_chat_member', async (msg) => {
            try {
                await this.handleLeftChatMember(msg);
            } catch (error) {
                this.logger.error('Error handling left chat member:', error);
            }
        });
        
        this.logger.info('✅ Bot handlers setup completed');
    }
    
    async handleMessage(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const username = msg.from.username;
        const text = msg.text;
        const isPrivateChat = msg.chat.type === 'private';
        const isGroupChat = chatId.toString() === this.config.groupId;
        
        this.logger.info(`收到消息 - ChatID: ${chatId}, UserID: ${userId}, Text: ${text}, Type: ${msg.chat.type}`);
        
        // 只处理私聊消息和群组管理消息
        if (!isPrivateChat && !isGroupChat) {
            return;
        }
        
        // 对于私聊消息，检查用户是否为群组成员
        if (isPrivateChat) {
            const isGroupMember = await this.checkUserInGroup(userId);
            if (!isGroupMember && !this.isAdmin(userId)) {
                await this.bot.sendMessage(chatId, `❌ 您不是授权群组的成员，无法使用此机器人。

请先加入授权群组，然后再私聊机器人使用功能。`);
                return;
            }
        }
        
        // 记录用户活动
        this.userValidator.recordUserActivity(userId, username);
        
        // 处理命令
        if (text && text.startsWith('/')) {
            await this.handleCommand(msg, isPrivateChat, isGroupChat);
        } else if (isPrivateChat) {
            // 在私聊中处理非命令消息（如token验证）
            await this.handleTextMessage(msg);
        }
    }

    async handleCommand(msg, isPrivateChat, isGroupChat) {
        const command = msg.text.split(' ')[0].toLowerCase();
        const args = msg.text.split(' ').slice(1);
        const userId = msg.from.id;
        
        this.logger.info(`处理命令: ${command}, 用户: ${userId}, 私聊: ${isPrivateChat}, 群组: ${isGroupChat}`);
        
        try {
            // 如果在群组中使用机器人命令，引导用户私聊
            if (isGroupChat && !command.includes('@')) {
                await this.bot.sendMessage(msg.chat.id, `⚠️ 请私聊机器人使用所有功能以保护您的隐私。\n\n点击 @${(await this.bot.getMe()).username} 开始私聊。`, {
                    reply_to_message_id: msg.message_id
                });
                return;
            }
            
            // 处理带有@的群组命令（如/start@botname）
            const cleanCommand = command.split('@')[0];
            
            switch (cleanCommand) {
                case '/start':
                    if (isPrivateChat) {
                        await this.commandHandler.handleStart(msg, this.bot);
                    }
                    break;
                
                case '/help':
                    if (isPrivateChat) {
                        await this.commandHandler.handleHelp(msg, this.bot);
                    }
                    break;
                
                case '/gettoken':
                    if (isPrivateChat) {
                        await this.commandHandler.handleGetToken(msg, this.bot, this.tokenManager);
                    }
                    break;
                
                case '/mycredentials':
                    if (isPrivateChat) {
                        await this.commandHandler.handleMyCredentials(msg, this.bot);
                    }
                    break;
                
                case '/status':
                    if (isPrivateChat) {
                        await this.commandHandler.handleStatus(msg, this.bot);
                    }
                    break;
                
                case '/refresh':
                    if (isPrivateChat) {
                        await this.commandHandler.handleRefresh(msg, this.bot);
                    }
                    break;
                
                case '/revoke':
                    if (isPrivateChat) {
                        await this.commandHandler.handleRevoke(msg, this.bot, args);
                    }
                    break;
                
                // 管理员命令
                case '/admin':
                    if (this.isAdmin(msg.from.id) && isPrivateChat) {
                        await this.adminHandler.handleAdminCommand(msg, this.bot, args);
                    } else if (!isPrivateChat) {
                        await this.bot.sendMessage(msg.chat.id, '⚠️ 管理员命令请私聊机器人使用');
                    } else {
                        await this.bot.sendMessage(msg.chat.id, '❌ 您没有管理员权限');
                    }
                    break;
                
                default:
                    if (isPrivateChat) {
                        await this.bot.sendMessage(msg.chat.id, '❓ 未知命令，请使用 /help 查看可用命令');
                    }
            }
            
            this.logger.info(`命令 ${command} 处理完成`);
            
        } catch (error) {
            this.logger.error(`处理命令 ${command} 时出错:`, error);
            
            // 发送错误消息给用户
            try {
                await this.bot.sendMessage(msg.chat.id, `❌ 处理命令时出现错误: ${error.message}`);
            } catch (sendError) {
                this.logger.error('发送错误消息失败:', sendError);
            }
        }
    }
    
    async handleTextMessage(msg) {
        const chatId = msg.chat.id;
        
        // 检查是否是token验证（现在在私聊中处理）
        if (msg.text && msg.text.length === 8) {
            this.logger.info(`处理私聊中的令牌验证: ${msg.text}, 用户: ${msg.from.id}`);
            await this.commandHandler.handleTokenVerification(msg, this.bot, this.tokenManager);
        }
    }
    
    async handleChatMemberUpdate(update) {
        const userId = update.new_chat_member.user.id;
        const status = update.new_chat_member.status;
        
        if (status === 'member' || status === 'administrator' || status === 'creator') {
            this.groupMembers.add(userId);
            this.logger.info(`用户 ${userId} 加入群组成员列表`);
        } else if (status === 'left' || status === 'kicked') {
            this.groupMembers.delete(userId);
            await this.userValidator.revokeUserAccess(userId, 'Left group');
            this.logger.info(`用户 ${userId} 离开群组，撤销访问权限`);
            
            // 通知用户其访问权限已被撤销
            try {
                await this.bot.sendMessage(userId, '❌ 您已离开授权群组，访问权限已被撤销。\n\n如需继续使用，请重新加入群组。');
            } catch (error) {
                this.logger.error(`无法通知用户 ${userId} 权限撤销:`, error);
            }
        }
    }
    
    async handleNewChatMembers(msg) {
        const newMembers = msg.new_chat_members;
        
        for (const member of newMembers) {
            this.groupMembers.add(member.id);
            
            // 发送欢迎消息到群组
            const welcomeText = `🎉 欢迎 @${member.username || member.first_name} 加入群组！\n\n请私聊机器人 @${(await this.bot.getMe()).username} 使用 /start 命令开始获取IPTV访问权限。`;
            
            try {
                await this.bot.sendMessage(msg.chat.id, welcomeText);
            } catch (error) {
                this.logger.error('Error sending welcome message:', error);
            }
            
            // 同时私聊发送欢迎消息
            try {
                await this.bot.sendMessage(member.id, `🎉 欢迎加入授权群组！

您现在可以使用以下命令：
🔸 /start - 开始使用
🔸 /gettoken - 获取访问令牌
🔸 /help - 查看完整帮助

请使用 /gettoken 开始获取IPTV访问权限。`);
            } catch (error) {
                this.logger.debug(`无法私聊新成员 ${member.id}:`, error);
            }
        }
    }
    
    async handleLeftChatMember(msg) {
        const leftMember = msg.left_chat_member;
        this.groupMembers.delete(leftMember.id);
        
        // 撤销用户访问权限
        await this.userValidator.revokeUserAccess(leftMember.id, 'Left group');
    }
    
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
    
    async notifyAdmins(message) {
        const adminIds = this.getAllAdminIds();
        
        for (const adminId of adminIds) {
            try {
                await this.bot.sendMessage(adminId, message);
            } catch (error) {
                this.logger.error(`Failed to notify admin ${adminId}:`, error);
            }
        }
    }

    async sendDirectMessage(userId, message) {
        try {
            if (!this.bot) {
                throw new Error('Bot not initialized');
            }
            
            await this.bot.sendMessage(userId, message);
            this.logger.info(`Direct message sent to user ${userId}`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to send direct message to user ${userId}:`, error);
            return false;
        }
    }
    
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
    
    async checkUserInGroup(userId) {
        // 先检查本地缓存
        if (this.groupMembers.has(userId)) {
            return true;
        }
        
        try {
            const chatMember = await this.bot.getChatMember(this.config.groupId, userId);
            const isActive = ['member', 'administrator', 'creator'].includes(chatMember.status);
            
            if (isActive) {
                this.groupMembers.add(userId);
            } else {
                this.groupMembers.delete(userId);
            }
            
            return isActive;
        } catch (error) {
            this.logger.error(`Error checking user ${userId} in group:`, error);
            return false;
        }
    }
    
    startAllTasks() {
        this.startCleanupTask();
        this.startMemberCheckTask();
        this.startDataSaveTask();
    }
    
    startCleanupTask() {
        setInterval(() => {
            this.tokenManager.cleanupExpiredTokens();
        }, 60000); // 每分钟清理一次
    }
    
    startMemberCheckTask() {
        setInterval(async () => {
            await this.initializeGroupMembers();
        }, 600000); // 每10分钟同步一次群组成员
    }
    
    startDataSaveTask() {
        setInterval(() => {
            this.tokenManager.saveData();
            this.userValidator.saveData();
        }, 300000); // 每5分钟保存一次数据
    }
    
    getStats() {
        return {
            groupMembers: this.groupMembers.size,
            activeTokens: this.tokenManager.getActiveTokenCount(),
            botStatus: this.bot && !this.isShuttingDown ? 'online' : 'offline'
        };
    }
    
    async gracefulShutdown() {
        this.isShuttingDown = true;
        
        try {
            this.logger.info('🔄 开始关闭Telegram机器人...');
            
            // 保存所有数据
            this.tokenManager.saveData();
            this.userValidator.saveData();
            
            // 通知管理员机器人即将下线
            if (this.bot) {
                try {
                    await this.notifyAdmins('🔄 Xtream Codes Proxy bot is shutting down...');
                } catch (notifyError) {
                    this.logger.warn('通知管理员关闭消息失败:', notifyError.message);
                }
                
                // 停止轮询
                try {
                    await this.bot.stopPolling();
                    this.logger.info('✅ Telegram机器人轮询已停止');
                } catch (stopError) {
                    this.logger.warn('停止轮询时出错:', stopError.message);
                }
                
                // 清理机器人实例
                this.bot = null;
            }
            
            this.logger.info('✅ Telegram bot shutdown completed');
        } catch (error) {
            this.logger.error('❌ Error during bot shutdown:', error.message);
        }
    }
}

module.exports = TelegramBotManager; 