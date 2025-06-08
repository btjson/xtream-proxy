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
            
            console.log('✅ Telegram机器人已成功启动并连接');
            this.logger.info('✅ Telegram bot initialized successfully');
            
            // 通知管理员机器人已启动
            await this.notifyAdmins('🤖 Xtream Codes Proxy bot is now online!');
            
        } catch (error) {
            console.log('❌ Telegram机器人初始化失败:', error.message);
            this.logger.error('❌ Failed to initialize Telegram bot:', error.message);
            
            // 如果是409冲突错误，等待更长时间后重试
            if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
                console.log('⏳ 检测到机器人冲突，30秒后重试...');
                this.logger.info('⏳ 等待30秒后重试初始化机器人...');
                setTimeout(() => {
                    this.initializeBot();
                }, 30000);
            } else {
                // 其他错误，等待5秒后重试
                console.log('⏳ 5秒后重试初始化机器人...');
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
        // 设置群组中的命令（只显示help）
        const groupCommands = [
            { command: 'help', description: '显示帮助信息' }
        ];
        
        // 设置普通用户私聊中的命令
        const privateCommands = [
            { command: 'start', description: '开始使用机器人' },
            { command: 'help', description: '显示帮助信息' },
            { command: 'gettoken', description: '获取访问令牌' },
            { command: 'mycredentials', description: '查看我的凭据' }
        ];
        
        // 设置管理员私聊中的命令（包含额外的管理员命令）
        const adminCommands = [
            { command: 'start', description: '开始使用机器人' },
            { command: 'help', description: '显示帮助信息' },
            { command: 'gettoken', description: '获取访问令牌' },
            { command: 'mycredentials', description: '查看我的凭据' },
            { command: 'status', description: '查看服务器状态' },
            { command: 'refresh', description: '刷新频道列表' },
            { command: 'admin', description: '管理员面板' },
            { command: 'addadmin', description: '添加管理员' },
            { command: 'removeadmin', description: '移除管理员' },
            { command: 'listadmins', description: '查看管理员列表' },
            { command: 'changem3u', description: '修改M3U订阅链接' }
        ];
        
        try {
            // 设置群组命令
            await this.bot.setMyCommands(groupCommands, {
                scope: { type: 'all_group_chats' }
            });
            
            // 设置普通用户私聊命令
            await this.bot.setMyCommands(privateCommands, {
                scope: { type: 'all_private_chats' }
            });
            
            // 为每个管理员设置特殊命令
            const adminIds = this.getAllAdminIds();
            for (const adminId of adminIds) {
                try {
                    await this.bot.setMyCommands(adminCommands, {
                        scope: { 
                            type: 'chat',
                            chat_id: parseInt(adminId)
                        }
                    });
                } catch (error) {
                    // 如果用户还没有与机器人开始对话，会出现 "chat not found" 错误
                    // 这是正常的，当用户首次与机器人对话时会自动设置命令
                    this.logger.debug(`无法为管理员 ${adminId} 设置命令 (用户可能还未与机器人对话):`, error.message);
                }
            }
            
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
            // 根据错误类型显示不同的终端提示
            if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
                console.log('⚠️  检测到Telegram机器人冲突，正在重启...');
                this.logger.warn('⚠️  检测到机器人冲突，停止轮询并等待重启...');
                
                // 停止轮询
                this.bot.stopPolling().then(() => {
                    console.log('🔄 机器人轮询已停止，30秒后自动重启');
                    this.logger.info('✅ 轮询已停止，等待30秒后重新初始化...');
                    
                    // 等待30秒后重新初始化
                    setTimeout(() => {
                        console.log('🚀 正在重新初始化Telegram机器人...');
                        this.initializeBot();
                    }, 30000);
                }).catch(stopError => {
                    console.log('❌ 停止机器人轮询时出错:', stopError.message);
                    this.logger.error('停止轮询时出错:', stopError.message);
                });
                
                return;
            }
            
            // 如果是网络错误，尝试重启轮询
            if (error.code === 'EFATAL' || error.code === 'EPARSE' || error.code === 'ENOTFOUND') {
                console.log('🌐 网络连接问题，5秒后自动重试...');
                this.logger.info('⏳ 网络错误，5秒后尝试重启轮询...');
                setTimeout(() => {
                    if (this.bot && !this.isShuttingDown) {
                        this.bot.startPolling().catch(restartError => {
                            console.log('❌ 重启机器人轮询失败:', restartError.message);
                            this.logger.error('重启轮询失败:', restartError.message);
                        });
                    }
                }, 5000);
            } else {
                // 其他错误只记录到日志，不显示在终端
                this.logger.debug('Telegram polling error:', error.message);
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
                await this.bot.sendMessage(chatId, `❌ 你没有权限获得链接

🔒 权限说明：
• 只有指定群组的成员才能获得订阅链接
• 请先加入授权群组
• 加入群组后即可使用所有功能

请联系管理员获取群组邀请链接。`);
                return;
            }
            
            // 如果是管理员首次对话，设置管理员命令
            if (this.isAdmin(userId)) {
                try {
                    await this.setupAdminCommands(userId.toString());
                } catch (error) {
                    this.logger.debug(`为管理员 ${userId} 设置命令失败:`, error.message);
                }
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
                    } else if (isGroupChat) {
                        // 在群组中提示用户私聊机器人
                        const botInfo = await this.bot.getMe();
                        await this.bot.sendMessage(msg.chat.id, `💬 请点击机器人头像 @${botInfo.username} 进行私聊获取帮助信息。\n\n🔒 为了保护您的隐私，所有功能都在私聊中使用。`, {
                            reply_to_message_id: msg.message_id
                        });
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
                    if (this.isAdmin(msg.from.id) && isPrivateChat) {
                        await this.commandHandler.handleStatus(msg, this.bot);
                    } else if (!isPrivateChat) {
                        await this.bot.sendMessage(msg.chat.id, '⚠️ 管理员命令请私聊机器人使用');
                    } else {
                        await this.bot.sendMessage(msg.chat.id, '❌ 您没有管理员权限');
                    }
                    break;
                
                case '/refresh':
                    if (this.isAdmin(msg.from.id) && isPrivateChat) {
                        await this.commandHandler.handleRefresh(msg, this.bot);
                    } else if (!isPrivateChat) {
                        await this.bot.sendMessage(msg.chat.id, '⚠️ 管理员命令请私聊机器人使用');
                    } else {
                        await this.bot.sendMessage(msg.chat.id, '❌ 您没有管理员权限');
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
                
                case '/addadmin':
                    if (this.isAdmin(msg.from.id) && isPrivateChat) {
                        await this.handleAddAdmin(msg, args);
                    } else if (!isPrivateChat) {
                        await this.bot.sendMessage(msg.chat.id, '⚠️ 管理员命令请私聊机器人使用');
                    } else {
                        await this.bot.sendMessage(msg.chat.id, '❌ 您没有管理员权限');
                    }
                    break;
                
                case '/removeadmin':
                    if (this.isAdmin(msg.from.id) && isPrivateChat) {
                        await this.handleRemoveAdmin(msg, args);
                    } else if (!isPrivateChat) {
                        await this.bot.sendMessage(msg.chat.id, '⚠️ 管理员命令请私聊机器人使用');
                    } else {
                        await this.bot.sendMessage(msg.chat.id, '❌ 您没有管理员权限');
                    }
                    break;
                
                case '/listadmins':
                    if (this.isAdmin(msg.from.id) && isPrivateChat) {
                        await this.handleListAdmins(msg);
                    } else if (!isPrivateChat) {
                        await this.bot.sendMessage(msg.chat.id, '⚠️ 管理员命令请私聊机器人使用');
                    } else {
                        await this.bot.sendMessage(msg.chat.id, '❌ 您没有管理员权限');
                    }
                    break;
                
                case '/changem3u':
                    if (this.isAdmin(msg.from.id) && isPrivateChat) {
                        await this.adminHandler.handleChangeM3U(msg, this.bot, args);
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
                // 如果是用户还未与机器人开始对话的错误，只记录debug日志
                if (error.code === 'ETELEGRAM' && 
                    (error.message.includes("bot can't initiate conversation") || 
                     error.message.includes("chat not found"))) {
                    this.logger.debug(`无法通知管理员 ${adminId} (用户还未与机器人开始对话):`, error.message);
                } else {
                    this.logger.error(`Failed to notify admin ${adminId}:`, error);
                }
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
        this.startAutoRefreshTask();
        this.startExpiryCheckTask();
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

    startAutoRefreshTask() {
        // 每两小时自动刷新频道列表
        setInterval(async () => {
            try {
                this.logger.info('开始自动刷新频道列表...');
                
                if (this.userManager.channelManager && this.userManager.channelManager.refreshChannels) {
                    const oldChannelCount = this.userManager.channelManager.getChannelCount();
                    await this.userManager.channelManager.refreshChannels();
                    const newChannelCount = this.userManager.channelManager.getChannelCount();
                    
                    const message = `🔄 自动刷新完成

📺 频道数量：${oldChannelCount} → ${newChannelCount}
⏰ 刷新时间：${new Date().toLocaleString()}
🔗 当前链接：${this.config.originalServer?.url || '未设置'}

💡 所有用户需要重新获取播放列表才能看到更新的频道。`;
                    
                    // 通知所有管理员
                    await this.notifyAdmins(message);
                    
                    this.logger.info(`自动刷新完成：${oldChannelCount} → ${newChannelCount} 频道`);
                } else {
                    this.logger.warn('频道管理器不可用，跳过自动刷新');
                }
            } catch (error) {
                this.logger.error('自动刷新失败:', error);
                
                // 通知管理员刷新失败
                const errorMessage = `❌ 自动刷新失败

⏰ 失败时间：${new Date().toLocaleString()}
🔗 当前链接：${this.config.originalServer?.url || '未设置'}
❗ 错误信息：${error.message}

请检查M3U链接是否有效或手动执行 /refresh 命令。`;
                
                await this.notifyAdmins(errorMessage);
            }
        }, 2 * 60 * 60 * 1000); // 每2小时执行一次
    }

    startExpiryCheckTask() {
        // 每小时检查用户过期情况
        setInterval(async () => {
            try {
                await this.checkUserExpiry();
            } catch (error) {
                this.logger.error('检查用户过期状态失败:', error);
            }
        }, 60 * 60 * 1000); // 每小时执行一次
    }

    async checkUserExpiry() {
        const users = this.userManager.getUsers();
        const now = Date.now();
        
        for (const [username, user] of Object.entries(users)) {
            if (user.telegramUserId && user.expiryTime) {
                const timeUntilExpiry = user.expiryTime - now;
                const hoursUntilExpiry = Math.floor(timeUntilExpiry / (60 * 60 * 1000));
                
                // 检查是否需要发送过期提醒
                if (timeUntilExpiry > 0 && hoursUntilExpiry <= 24 && !user.expiryNotified) {
                    await this.sendExpiryNotification(user.telegramUserId, username, hoursUntilExpiry);
                    // 标记已通知，避免重复发送
                    user.expiryNotified = true;
                    this.userManager.updateUser(username, { expiryNotified: true });
                }
                
                // 检查是否已过期
                if (timeUntilExpiry <= 0 && user.enabled) {
                    await this.handleUserExpiry(user.telegramUserId, username);
                    // 禁用用户
                    this.userManager.updateUser(username, { enabled: false });
                }
            }
        }
    }

    async sendExpiryNotification(telegramUserId, username, hoursLeft) {
        try {
            const message = `⏰ 链接即将过期提醒

🔗 您的IPTV访问链接将在 ${hoursLeft} 小时后过期

📝 过期时间：${new Date(Date.now() + hoursLeft * 60 * 60 * 1000).toLocaleString()}

🔄 续期方法：
• 使用 /gettoken 命令重新获取新的访问令牌
• 验证令牌后将获得新的24小时访问权限

💡 建议您提前续期以避免服务中断。`;

            await this.bot.sendMessage(telegramUserId, message);
            this.logger.info(`发送过期提醒给用户 ${username} (${telegramUserId})`);
        } catch (error) {
            this.logger.error(`发送过期提醒失败 ${username}:`, error);
        }
    }

    async handleUserExpiry(telegramUserId, username) {
        try {
            const message = `❌ 访问链接已过期

🔗 您的IPTV访问链接已于 ${new Date().toLocaleString()} 过期

🔄 重新获取访问权限：
1. 使用 /gettoken 命令获取新的访问令牌
2. 在私聊中发送令牌进行验证
3. 验证成功后获得新的24小时访问权限

💡 每次验证后都会获得新的24小时访问期限。`;

            await this.bot.sendMessage(telegramUserId, message);
            this.logger.info(`用户 ${username} (${telegramUserId}) 访问权限已过期`);
        } catch (error) {
            this.logger.error(`发送过期通知失败 ${username}:`, error);
        }
    }
    
    getStats() {
        return {
            groupMembers: this.groupMembers.size,
            activeTokens: this.tokenManager.getActiveTokenCount(),
            botStatus: this.bot && !this.isShuttingDown ? 'online' : 'offline'
        };
    }
    
    async handleAddAdmin(msg, args) {
        try {
            if (args.length === 0) {
                await this.bot.sendMessage(msg.chat.id, `❓ 请提供要添加的管理员用户ID

📝 使用方法：
\`/addadmin 用户ID\`

例如：\`/addadmin 123456789\`

💡 提示：用户ID可以通过转发用户消息给 @userinfobot 获取`, { parse_mode: 'Markdown' });
                return;
            }
            
            const newAdminId = args[0].toString();
            
            // 检查是否已经是管理员
            if (this.isAdmin(newAdminId)) {
                await this.bot.sendMessage(msg.chat.id, `⚠️ 用户 ${newAdminId} 已经是管理员了`);
                return;
            }
            
            // 添加到管理员列表
            if (!this.config.adminUserIds) {
                this.config.adminUserIds = [];
            }
            
            this.config.adminUserIds.push(newAdminId);
            
            // 保存配置到文件
            await this.saveConfig();
            
            // 重新加载配置以确保新管理员被识别
            await this.reloadConfig();
            
            // 为新管理员设置命令
            await this.setupAdminCommands(newAdminId);
            
            await this.bot.sendMessage(msg.chat.id, `✅ 成功添加管理员：${newAdminId}

🔧 新管理员现在可以使用所有管理员命令`);
            
            // 通知新管理员
            try {
                await this.bot.sendMessage(newAdminId, `🎉 您已被添加为 Xtream Codes Proxy 机器人的管理员！

🔧 您现在可以使用以下管理员命令：
• /admin - 管理员面板
• /refresh - 刷新频道列表
• /addadmin - 添加管理员
• /removeadmin - 移除管理员
• /listadmins - 查看管理员列表

请重新启动与机器人的对话以看到新的命令菜单。`);
            } catch (error) {
                // 如果是用户还未与机器人开始对话的错误，只记录debug日志
                if (error.code === 'ETELEGRAM' && 
                    (error.message.includes("bot can't initiate conversation") || 
                     error.message.includes("chat not found"))) {
                    this.logger.debug(`无法通知新管理员 ${newAdminId} (用户还未与机器人开始对话):`, error.message);
                } else {
                    this.logger.debug(`无法通知新管理员 ${newAdminId}:`, error.message);
                }
            }
            
            this.logger.info(`管理员 ${msg.from.id} 添加了新管理员 ${newAdminId}`);
            
        } catch (error) {
            this.logger.error('添加管理员失败:', error);
            await this.bot.sendMessage(msg.chat.id, `❌ 添加管理员失败：${error.message}`);
        }
    }
    
    async handleRemoveAdmin(msg, args) {
        try {
            if (args.length === 0) {
                await this.bot.sendMessage(msg.chat.id, `❓ 请提供要移除的管理员用户ID

📝 使用方法：
\`/removeadmin 用户ID\`

例如：\`/removeadmin 123456789\`

⚠️ 注意：您不能移除自己的管理员权限`, { parse_mode: 'Markdown' });
                return;
            }
            
            const removeAdminId = args[0].toString();
            const currentAdminId = msg.from.id.toString();
            
            // 不能移除自己
            if (removeAdminId === currentAdminId) {
                await this.bot.sendMessage(msg.chat.id, `❌ 您不能移除自己的管理员权限`);
                return;
            }
            
            // 检查是否是管理员
            if (!this.isAdmin(removeAdminId)) {
                await this.bot.sendMessage(msg.chat.id, `⚠️ 用户 ${removeAdminId} 不是管理员`);
                return;
            }
            
            // 从管理员列表中移除
            if (this.config.adminUserIds) {
                this.config.adminUserIds = this.config.adminUserIds.filter(id => id !== removeAdminId);
            }
            
            // 如果是旧格式的主管理员，不能移除
            if (this.config.adminUserId === removeAdminId) {
                await this.bot.sendMessage(msg.chat.id, `❌ 无法移除主管理员 ${removeAdminId}`);
                return;
            }
            
            // 保存配置到文件
            await this.saveConfig();
            
            // 重新加载配置以确保管理员权限更新
            await this.reloadConfig();
            
            // 为该用户重置为普通用户命令
            await this.setupUserCommands(removeAdminId);
            
            await this.bot.sendMessage(msg.chat.id, `✅ 成功移除管理员：${removeAdminId}`);
            
            // 通知被移除的管理员
            try {
                await this.bot.sendMessage(removeAdminId, `⚠️ 您的 Xtream Codes Proxy 机器人管理员权限已被移除。

您现在只能使用普通用户命令。请重新启动与机器人的对话以看到更新的命令菜单。`);
            } catch (error) {
                // 如果是用户还未与机器人开始对话的错误，只记录debug日志
                if (error.code === 'ETELEGRAM' && 
                    (error.message.includes("bot can't initiate conversation") || 
                     error.message.includes("chat not found"))) {
                    this.logger.debug(`无法通知被移除的管理员 ${removeAdminId} (用户还未与机器人开始对话):`, error.message);
                } else {
                    this.logger.debug(`无法通知被移除的管理员 ${removeAdminId}:`, error.message);
                }
            }
            
            this.logger.info(`管理员 ${currentAdminId} 移除了管理员 ${removeAdminId}`);
            
        } catch (error) {
            this.logger.error('移除管理员失败:', error);
            await this.bot.sendMessage(msg.chat.id, `❌ 移除管理员失败：${error.message}`);
        }
    }
    
    async handleListAdmins(msg) {
        try {
            const adminIds = this.getAllAdminIds();
            
            if (adminIds.length === 0) {
                await this.bot.sendMessage(msg.chat.id, `❌ 未找到管理员列表`);
                return;
            }
            
            let adminList = `👥 管理员列表 (${adminIds.length} 人)：\n\n`;
            
            for (let i = 0; i < adminIds.length; i++) {
                const adminId = adminIds[i];
                let adminInfo = `${i + 1}. ID: ${adminId}`;
                
                // 尝试获取用户信息
                try {
                    const chatMember = await this.bot.getChatMember(this.config.groupId, adminId);
                    if (chatMember.user.username) {
                        adminInfo += ` (@${chatMember.user.username})`;
                    }
                    if (chatMember.user.first_name) {
                        // 转义特殊字符以避免Markdown解析错误
                        const firstName = chatMember.user.first_name.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
                        adminInfo += ` - ${firstName}`;
                    }
                } catch (error) {
                    // 如果无法获取用户信息，只显示ID
                    this.logger.debug(`无法获取管理员 ${adminId} 的信息:`, error);
                }
                
                // 标记主管理员
                if (adminId === this.config.adminUserId) {
                    adminInfo += ` 👑 (主管理员)`;
                }
                
                adminList += adminInfo + '\n';
            }
            
            // 不使用Markdown格式，避免解析错误
            await this.bot.sendMessage(msg.chat.id, adminList);
            
        } catch (error) {
            this.logger.error('获取管理员列表失败:', error);
            await this.bot.sendMessage(msg.chat.id, `❌ 获取管理员列表失败：${error.message}`);
        }
    }
    
    async setupAdminCommands(adminId) {
        try {
            const adminCommands = [
                { command: 'start', description: '开始使用机器人' },
                { command: 'help', description: '显示帮助信息' },
                { command: 'gettoken', description: '获取访问令牌' },
                { command: 'mycredentials', description: '查看我的凭据' },
                { command: 'status', description: '查看服务器状态' },
                { command: 'refresh', description: '刷新频道列表' },
                { command: 'admin', description: '管理员面板' },
                { command: 'addadmin', description: '添加管理员' },
                { command: 'removeadmin', description: '移除管理员' },
                { command: 'listadmins', description: '查看管理员列表' },
                { command: 'changem3u', description: '修改M3U订阅链接' }
            ];
            
            await this.bot.setMyCommands(adminCommands, {
                scope: { 
                    type: 'chat',
                    chat_id: parseInt(adminId)
                }
            });
        } catch (error) {
            // 如果是用户还未与机器人开始对话的错误，只记录debug日志
            if (error.code === 'ETELEGRAM' && 
                (error.message.includes("bot can't initiate conversation") || 
                 error.message.includes("chat not found"))) {
                this.logger.debug(`无法为管理员 ${adminId} 设置命令 (用户还未与机器人开始对话):`, error.message);
            } else {
                this.logger.error(`为管理员 ${adminId} 设置命令失败:`, error);
            }
        }
    }
    
    async setupUserCommands(userId) {
        try {
            const userCommands = [
                { command: 'start', description: '开始使用机器人' },
                { command: 'help', description: '显示帮助信息' },
                { command: 'gettoken', description: '获取访问令牌' },
                { command: 'mycredentials', description: '查看我的凭据' },
                { command: 'status', description: '查看服务器状态' }
            ];
            
            await this.bot.setMyCommands(userCommands, {
                scope: { 
                    type: 'chat',
                    chat_id: parseInt(userId)
                }
            });
        } catch (error) {
            // 如果是用户还未与机器人开始对话的错误，只记录debug日志
            if (error.code === 'ETELEGRAM' && 
                (error.message.includes("bot can't initiate conversation") || 
                 error.message.includes("chat not found"))) {
                this.logger.debug(`无法为用户 ${userId} 设置命令 (用户还未与机器人开始对话):`, error.message);
            } else {
                this.logger.error(`为用户 ${userId} 设置命令失败:`, error);
            }
        }
    }
    
    async saveConfig() {
        const fs = require('fs').promises;
        const path = require('path');
        
        try {
            const configPath = path.join(__dirname, '../../config.json');
            const configData = {
                server: this.serverConfig,
                originalServer: this.userManager.config.originalServer,
                telegram: this.config,
                users: this.userManager.config.users,
                security: this.userManager.config.security,
                features: this.userManager.config.features,
                playlist: this.userManager.config.playlist
            };
            
            await fs.writeFile(configPath, JSON.stringify(configData, null, 2));
            this.logger.info('配置文件已保存');
        } catch (error) {
            this.logger.error('保存配置文件失败:', error);
            throw error;
        }
    }
    
    async reloadConfig() {
        const fs = require('fs').promises;
        const path = require('path');
        
        try {
            const configPath = path.join(__dirname, '../../config.json');
            const configData = await fs.readFile(configPath, 'utf8');
            const newConfig = JSON.parse(configData);
            
            // 更新Telegram配置
            this.config = newConfig.telegram;
            
            this.logger.info('配置文件已重新加载');
        } catch (error) {
            this.logger.error('重新加载配置文件失败:', error);
            throw error;
        }
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