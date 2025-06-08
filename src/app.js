const express = require('express');
const path = require('path');
const fs = require('fs');

const UserManager = require('./managers/UserManager');
const TelegramBotManager = require('./managers/TelegramBotManager');
const ChannelManager = require('./managers/ChannelManager');
const SecurityManager = require('./managers/SecurityManager');
const ConfigManager = require('./utils/ConfigManager');
const Logger = require('./utils/Logger');

const playerRoutes = require('./routes/player');
const adminRoutes = require('./routes/admin');
const streamRoutes = require('./routes/stream');

class XtreamCodesProxy {
    constructor() {
        this.app = express();
        
        // 初始化配置管理器
        this.configManager = new ConfigManager();
        this.config = this.configManager.getConfig();
        
        // 初始化日志记录器
        this.logger = new Logger(this.config);
        
        this.port = process.env.PORT || this.config.server.port;
        
        // 初始化管理器
        this.userManager = new UserManager(this.config, this.logger);
        this.channelManager = new ChannelManager(this.config, this.logger);
        this.securityManager = new SecurityManager(this.config, this.logger);
        
        // 设置管理器之间的依赖关系
        this.userManager.setChannelManager(this.channelManager);
        
        // 初始化Telegram机器人
        if (this.config.features.enableTelegramBot) {
            this.telegramBot = new TelegramBotManager(this.config, this.userManager, this.logger);
        }
        
        this.setupMiddleware();
        this.setupRoutes();
        this.initializeServices();
        this.setupGracefulShutdown();
    }
    
    setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
        
        // CORS配置
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
            
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
            } else {
                next();
            }
        });
        
        // 请求日志中间件
        if (this.config.security.enableLogging) {
            this.app.use((req, res, next) => {
                const truncatedUrl = Logger.truncateUrlForLogging(req.url);
                this.logger.info(`${req.method} ${truncatedUrl} - ${req.ip}`);
                next();
            });
        }
        
        // 安全中间件
        this.app.use((req, res, next) => {
            this.securityManager.validateRequest(req, res, next);
        });
    }
    
    setupRoutes() {
        // API路由
        this.app.use('/player_api.php', playerRoutes(this.userManager, this.channelManager, this.securityManager));
        this.app.use('/admin', adminRoutes(this.userManager, this.channelManager, this.config));
        this.app.use('/live', streamRoutes(this.userManager, this.channelManager, this.securityManager));
        
        // 添加stream路由的别名以保持兼容性
        this.app.use('/stream', streamRoutes(this.userManager, this.channelManager, this.securityManager));
        
        // 兼容路由
        this.app.get('/get.php', (req, res) => this.handleGetPlaylist(req, res));
        this.app.get('/xmltv.php', (req, res) => this.handleXMLTV(req, res));
        
        // 健康检查
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                version: require('../package.json').version
            });
        });
        
        // 默认路由
        this.app.get('/', (req, res) => {
            res.json({
                message: 'Xtream Codes Proxy Server',
                version: require('../package.json').version,
                status: 'running'
            });
        });
    }
    
    async initializeServices() {
        try {
            // 初始化用户管理器
            await this.userManager.initialize();
            
            // 初始化频道管理器
            await this.channelManager.initialize();
            
            // 启动定时任务
            this.startBackgroundTasks();
            
            this.logger.info('✅ All services initialized successfully');
        } catch (error) {
            this.logger.error('❌ Error initializing services:', error);
            throw error;
        }
    }
    
    startBackgroundTasks() {
        // 启动清理任务
        setInterval(() => {
            this.userManager.cleanup();
            this.securityManager.cleanup();
        }, this.config.security.cleanupInterval || 30000);
        
        // 启动频道刷新任务
        if (this.config.features.channelRefreshInterval > 0) {
            setInterval(() => {
                this.channelManager.refreshChannels();
            }, this.config.features.channelRefreshInterval);
        }
        
        // 启动Telegram机器人任务
        if (this.telegramBot) {
            this.telegramBot.startAllTasks();
        }
    }
    
    async handleGetPlaylist(req, res) {
        try {
            const clientIP = this.securityManager.getClientIP(req);
            console.log(`📋 Playlist request from ${clientIP} for user: ${req.query.username}`);
            this.logger.info(`Playlist request from ${clientIP} for user: ${req.query.username}`);
            
            const playlist = await this.userManager.generatePlaylist(req.query, clientIP);
            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Content-Disposition', 'attachment; filename="playlist.m3u"');
            res.send(playlist);
            
            console.log(`✅ Playlist generated successfully for user: ${req.query.username}`);
            this.logger.info(`Playlist generated successfully for user: ${req.query.username}`);
        } catch (error) {
            console.error(`❌ Playlist generation error for ${req.query.username}:`, error.message || error);
            this.logger.error('Playlist generation error:', error.message || error);
            
            if (error.message.includes('Hourly playlist refresh limit exceeded')) {
                // 通知Telegram机器人发送消息给用户
                if (this.telegramBot && req.query.username) {
                    await this.notifyUserLimitExceeded(req.query.username);
                }
                
                res.status(429).json({
                    error: 'Rate limit exceeded',
                    message: 'Hourly playlist refresh limit exceeded (10 times per hour)'
                });
            } else if (error.message.includes('Authentication failed')) {
                res.status(401).json({
                    error: 'Authentication failed',
                    message: 'Invalid username or password'
                });
            } else if (error.message.includes('No channels available')) {
                res.status(503).json({
                    error: 'Service unavailable',
                    message: 'No channels available. Please contact administrator.'
                });
            } else {
                res.status(500).json({
                    error: 'Internal Server Error',
                    message: 'Failed to generate playlist'
                });
            }
        }
    }

    async notifyUserLimitExceeded(username) {
        try {
            // 查找用户的Telegram ID
            const users = this.userManager.getUsers();
            const user = users[username];
            
            if (user && user.telegramUserId && user.source === 'telegram') {
                const message = `⚠️ 播放列表链接已失效

🚫 您的播放列表刷新次数已达到每小时限制（10次/小时）

📝 解决方案：
• 使用 /gettoken 生成新的令牌
• 验证令牌获取新的播放列表链接
• 新链接将重置刷新计数

⏰ 或者等待1小时后重试当前链接

💡 建议：避免频繁刷新播放列表，以免再次触发限制`;

                await this.telegramBot.sendDirectMessage(user.telegramUserId, message);
                console.log(`📱 已通知用户 ${username} 播放列表限制`);
                this.logger.info(`Notified user ${username} about playlist limit exceeded`);
            }
        } catch (error) {
            console.error(`❌ 通知用户失败:`, error.message);
            this.logger.error('Failed to notify user about limit exceeded:', error);
        }
    }
    
    async handleXMLTV(req, res) {
        try {
            const xmltv = await this.channelManager.generateXMLTV();
            res.setHeader('Content-Type', 'application/xml');
            res.send(xmltv);
        } catch (error) {
            this.logger.error('XMLTV generation error:', error);
            res.status(500).send('Internal Server Error');
        }
    }
    
    setupGracefulShutdown() {
        const gracefulShutdown = async (signal) => {
            this.logger.info(`Received ${signal}, starting graceful shutdown...`);
            
            try {
                // 停止接受新连接
                if (this.server) {
                    this.server.close();
                }
                
                // 清理资源
                if (this.telegramBot) {
                    await this.telegramBot.gracefulShutdown();
                }
                
                await this.userManager.gracefulShutdown();
                await this.channelManager.gracefulShutdown();
                
                this.logger.info('✅ Graceful shutdown completed');
                process.exit(0);
            } catch (error) {
                this.logger.error('❌ Error during graceful shutdown:', error);
                process.exit(1);
            }
        };
        
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));
    }
    
    start() {
        this.server = this.app.listen(this.port, this.config.server.host, () => {
            console.log(`🚀 Xtream Codes Proxy Server running on http://${this.config.server.host}:${this.port}`);
            console.log(`📋 Available endpoints:`);
            console.log(`   - Playlist: http://${this.config.server.host}:${this.port}/get.php?username=USER&password=PASS&type=m3u_plus`);
            console.log(`   - Player API: http://${this.config.server.host}:${this.port}/player_api.php`);
            console.log(`   - Live Stream: http://${this.config.server.host}:${this.port}/live/encrypted/TOKEN`);
            console.log(`   - Health Check: http://${this.config.server.host}:${this.port}/health`);
            this.logger.info(`🚀 Xtream Codes Proxy Server running on http://${this.config.server.host}:${this.port}`);
        });
        
        this.server.on('error', (error) => {
            console.error('❌ Server error:', error);
            this.logger.error('Server error:', error);
        });
        
        return this.server;
    }

    // 添加公共的gracefulShutdown方法供外部调用
    async gracefulShutdown() {
        this.logger.info('Starting graceful shutdown...');
        
        try {
            // 停止接受新连接
            if (this.server) {
                this.server.close();
            }
            
            // 清理资源
            if (this.telegramBot) {
                await this.telegramBot.gracefulShutdown();
            }
            
            await this.userManager.gracefulShutdown();
            await this.channelManager.gracefulShutdown();
            
            this.logger.info('✅ Graceful shutdown completed');
            process.exit(0);
        } catch (error) {
            this.logger.error('❌ Error during graceful shutdown:', error);
            process.exit(1);
        }
    }
}



module.exports = XtreamCodesProxy; 