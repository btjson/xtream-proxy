const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const TelegramBotManager = require('./telegram-bot');

class XtreamCodesProxy {
    constructor() {
        this.app = express();
        
        // 加载配置文件
        this.loadConfig();
        
        this.port = process.env.PORT || this.config.server.port;
        this.originalServer = this.config.originalServer;
        
        // 初始化用户数据
        this.users = {};
        this.telegramUsers = new Map(); // 存储Telegram用户
        this.initializeUsers();
        
        // 新增：播放列表请求限制跟踪
        this.playlistRequestLimits = new Map(); // 存储每个用户的请求限制信息
        
        // 新增：持久化播放列表管理
        this.persistentPlaylists = new Map(); // 存储永久有效的播放列表
        this.userPlaylistHistory = new Map(); // 存储用户播放列表历史
        
        // 初始化持久化存储
        this.initializePersistentStorage();
        
        // 初始化Telegram机器人
        this.telegramBot = new TelegramBotManager(this.config, this);
        
        // 存储解析后的频道列表
        this.channels = [];
        this.categories = [];
        
        // 保留连接管理对象（即使不使用，也保持兼容性）
        this.activeConnections = new Map();
        
        // 添加加密相关属性
        this.encryptionKey = this.generateEncryptionKey();
        this.redirectTokens = new Map(); // 存储重定向token的访问记录
        this.tokenUsageLimit = this.config.security?.maxTokenUsage || 3;
        
        this.setupMiddleware();
        this.setupRoutes();
        this.loadChannels();
        
        // 定期刷新频道列表
        if (this.config.features.channelRefreshInterval > 0) {
            setInterval(() => this.loadChannels(), this.config.features.channelRefreshInterval);
        }
        
        // 修改：定期清理过期的请求限制记录
        setInterval(() => this.cleanupExpiredPlaylistLimits(), 300000); // 每5分钟清理一次
        
        // 新增：定期清理过期的持久化播放列表
        if (this.config.playlist?.enablePersistentStorage) {
            setInterval(() => this.cleanupExpiredPersistentPlaylists(), 
                this.config.playlist.persistentStorageCleanupInterval || 86400000); // 默认每24小时清理一次
        }
        
        // 启动Telegram机器人所有定时任务
        if (this.telegramBot) {
            this.telegramBot.startAllTasks();
        }
        
        // 启动token清理任务
        this.startTokenCleanup();
        
        // 新增：启动原始服务器自动刷新任务
        this.startOriginalServerAutoRefresh();
        
        // 设置优雅关闭处理
        this.setupGracefulShutdown();
    }
    
    // 新增：初始化持久化存储
    initializePersistentStorage() {
        if (!this.config.playlist?.enablePersistentStorage) {
            return;
        }
        
        try {
            const dataDir = path.join(__dirname, 'data');
            const persistentPlaylistsFile = path.join(dataDir, 'persistent-playlists.json');
            const userHistoryFile = path.join(dataDir, 'user-playlist-history.json');
            
            // 确保data目录存在
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            
            // 加载持久化播放列表
            if (fs.existsSync(persistentPlaylistsFile)) {
                const data = JSON.parse(fs.readFileSync(persistentPlaylistsFile, 'utf8'));
                this.persistentPlaylists = new Map(Object.entries(data.playlists || {}));
                console.log(`✅ Loaded ${this.persistentPlaylists.size} persistent playlists`);
            }
            
            // 加载用户播放列表历史
            if (fs.existsSync(userHistoryFile)) {
                const data = JSON.parse(fs.readFileSync(userHistoryFile, 'utf8'));
                this.userPlaylistHistory = new Map(Object.entries(data.history || {}));
                console.log(`✅ Loaded playlist history for ${this.userPlaylistHistory.size} users`);
            }
            
        } catch (error) {
            console.error('❌ Error loading persistent storage:', error);
        }
    }
    
    // 新增：保存持久化数据
    savePersistentStorage() {
        if (!this.config.playlist?.enablePersistentStorage) {
            return;
        }
        
        try {
            const dataDir = path.join(__dirname, 'data');
            const persistentPlaylistsFile = path.join(dataDir, 'persistent-playlists.json');
            const userHistoryFile = path.join(dataDir, 'user-playlist-history.json');
            
            // 保存持久化播放列表
            const playlistsData = {
                playlists: Object.fromEntries(this.persistentPlaylists),
                lastUpdated: Date.now()
            };
            fs.writeFileSync(persistentPlaylistsFile, JSON.stringify(playlistsData, null, 2));
            
            // 保存用户历史
            const historyData = {
                history: Object.fromEntries(this.userPlaylistHistory),
                lastUpdated: Date.now()
            };
            fs.writeFileSync(userHistoryFile, JSON.stringify(historyData, null, 2));
            
        } catch (error) {
            console.error('❌ Error saving persistent storage:', error);
        }
    }
    
    // 设置优雅关闭处理
    setupGracefulShutdown() {
        const gracefulShutdown = async (signal) => {
            console.log(`\n🔄 Received ${signal}, starting graceful shutdown...`);
            
            try {
                // 保存Telegram机器人数据
                if (this.telegramBot) {
                    await this.telegramBot.gracefulShutdown();
                }
                
                // 关闭服务器
                if (this.server) {
                    this.server.close(() => {
                        console.log('✅ HTTP server closed');
                        process.exit(0);
                    });
                } else {
                    process.exit(0);
                }
            } catch (error) {
                console.error('❌ Error during graceful shutdown:', error);
                process.exit(1);
            }
        };
        
        // 监听关闭信号
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // nodemon restart
    }
    
    // 加载配置文件
    loadConfig() {
        try {
            const configPath = path.join(__dirname, 'config.json');
            const configData = fs.readFileSync(configPath, 'utf8');
            this.config = JSON.parse(configData);
            console.log('✅ Configuration loaded successfully');
        } catch (error) {
            console.warn('⚠️  Could not load config.json, using default configuration');
            this.config = {
                server: { port: 8080, host: '0.0.0.0' },
                originalServer: {
                    url: 'http://[2a13:e2c4:fefc:d372:bebd:f3b1:a0fc:1f65]:35455',
                    m3uPath: '/tv.m3u',
                    timeout: 10000
                },
                users: {
                    'admin': { password: 'admin123', maxConnections: 1, enabled: true }
                },
                security: {
                    connectionTimeout: 300000,
                    cleanupInterval: 30000,
                    enableLogging: true
                },
                features: {
                    enableAdmin: true,
                    enableStatus: true,
                    channelRefreshInterval: 3600000
                }
            };
        }
    }
    
    // 初始化用户
    initializeUsers() {
        for (const [username, userConfig] of Object.entries(this.config.users)) {
            if (userConfig.enabled) {
                this.users[username] = {
                    password: userConfig.password,
                    maxConnections: userConfig.maxConnections,
                    createdAt: new Date(),
                    lastActivity: new Date(),
                    enabled: userConfig.enabled
                };
            }
        }
    }
    
    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
        
        // 日志中间件
        if (this.config.security.enableLogging) {
            this.app.use((req, res, next) => {
                console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - IP: ${req.ip}`);
                next();
            });
        }
    }
    
    setupRoutes() {
        // Xtream Codes API端点
        this.app.get('/player_api.php', this.handlePlayerApi.bind(this));
        
        // 获取M3U播放列表
        this.app.get('/get.php', this.handleGetPlaylist.bind(this));
        
        // 新增：加密重定向端点
        this.app.get('/redirect/:username/:token', this.handleEncryptedRedirect.bind(this));
        
        // 直播流重定向（保留兼容性）
        this.app.get('/live/:username/:password/:streamId.:ext', this.handleLiveStream.bind(this));
        
        // 管理面板
        if (this.config.features.enableAdmin) {
            this.app.get('/admin', this.handleAdminPanel.bind(this));
            this.app.post('/admin/users', this.handleUserManagement.bind(this));
        }
        
        // 状态监控
        if (this.config.features.enableStatus) {
            this.app.get('/status', this.handleStatus.bind(this));
        }
        
        // XMLTV EPG
        this.app.get('/xmltv.php', this.handleXMLTV.bind(this));
        
        // 根路径
        this.app.get('/', (req, res) => {
            res.json({
                service: 'Xtream Codes Encrypted Redirect Proxy',
                version: '1.0.0',
                status: 'running',
                mode: 'encrypted_redirect',
                channels: this.channels.length,
                description: 'Server provides encrypted links that redirect to original sources. Traffic flows directly from original servers to users.',
                security: {
                    encrypted_links: true,
                    time_limited: true,
                    usage_limited: true,
                    ip_binding: this.config.security?.enableIPBinding || false
                },
                endpoints: {
                    player_api: '/player_api.php',
                    playlist: '/get.php',
                    redirect: '/redirect/{username}/{token}',
                    xmltv: '/xmltv.php',
                    admin: '/admin',
                    status: '/status'
                },
                usage: {
                    server_url: `${req.protocol}://${req.get('host')}`,
                    username: 'your_username',
                    password: 'your_password',
                    note: 'Links are encrypted and time-limited. Traffic redirects to original sources.'
                }
            });
        });
    }
    
    // 修改后的 removeTelegramUser 方法 - 确保清理播放列表限制
    removeTelegramUser(username) {
        if (this.telegramUsers.has(username)) {
            const userData = this.telegramUsers.get(username);
            this.telegramUsers.delete(username);
            delete this.users[username];
            
            // 清理播放列表限制记录
            if (this.playlistRequestLimits.has(username)) {
                this.playlistRequestLimits.delete(username);
                console.log(`🧹 Cleared playlist limits for removed user: ${username}`);
            }
            
            console.log(`✅ Removed Telegram user: ${username} (ID: ${userData.telegramUserId})`);
        }
    }
    
    // 修改后的 createTelegramUser 方法 - 创建新用户时清理旧限制
    createTelegramUser(username, password, telegramUserId) {
        // 如果是重新创建用户，先清理旧的限制记录
        if (this.playlistRequestLimits && this.playlistRequestLimits.has(username)) {
            this.playlistRequestLimits.delete(username);
            console.log(`🧹 Cleared old playlist limits for recreated user: ${username}`);
        }
        
        this.users[username] = {
            password: password,
            maxConnections: 2, // 默认最大连接数
            createdAt: new Date(),
            lastActivity: new Date(),
            enabled: true,
            telegramUserId: telegramUserId
        };
        
        this.telegramUsers.set(telegramUserId, username);
        console.log(`✅ Telegram user created: ${username} (ID: ${telegramUserId})`);
    }
    
    // 修改用户认证方法以支持Telegram用户
    authenticateUser(username, password) {
        // 首先检查配置文件中的用户
        let user = this.users[username];
        if (user && user.password === password && user.enabled) {
            user.lastActivity = new Date();
            return { success: true, user: user };
        }
        
        // 然后检查Telegram用户
        const telegramUser = this.telegramUsers.get(username);
        if (telegramUser && telegramUser.password === password && telegramUser.enabled) {
            telegramUser.lastActivity = new Date();
            return { success: true, user: telegramUser };
        }
        
        return { success: false, error: 'Invalid credentials or user disabled' };
    }
    
    // 修改检查播放列表请求限制的方法 - 添加调试信息
    async checkPlaylistRequestLimit(username, req) {
        const user = this.users[username];
        if (!user || !user.telegramUserId) {
            // 非Telegram用户不受限制
            return { allowed: true };
        }
        
        // 检查用户是否还在指定的Telegram群中
        const isInGroup = await this.checkUserInTelegramGroup(user.telegramUserId);
        if (!isInGroup) {
            return { 
                allowed: false, 
                reason: 'user_not_in_group',
                message: '您已不在指定的Telegram群组中，无法使用此服务。'
            };
        }
        
        const now = Date.now();
        const limitPeriod = this.config.playlist?.refreshLimitPeriod || 18000000; // 默认5小时
        const maxRequests = this.config.playlist?.maxRefreshesInPeriod || 5; // 默认5次
        const maxSimultaneous = this.config.playlist?.maxSimultaneousPlaylists || 3; // 默认3个
        
        // 获取或创建用户的请求限制记录
        let userLimit = this.playlistRequestLimits.get(username);
        if (!userLimit) {
            userLimit = {
                requests: [],
                disabled: false,
                disabledAt: null,
                createdAt: now,
                activePlaylists: [] // 存储当前活跃的播放列表
            };
            this.playlistRequestLimits.set(username, userLimit);
            console.log(`🆕 Created new playlist limit record for user ${username}`);
        }
        
        // 检查用户是否已有永久播放列表
        const userHistory = this.getUserPlaylistHistory(username);
        if (userHistory.qualifiedForPermanent) {
            console.log(`👑 User ${username} qualified for permanent playlists`);
        }
        
        // 清理过期的活跃播放列表
        const temporaryExpiry = this.config.playlist?.temporaryLinkExpiry || 7200000; // 默认2小时
        userLimit.activePlaylists = userLimit.activePlaylists.filter(playlist => {
            if (userHistory.qualifiedForPermanent) {
                return true; // 永久用户的播放列表不过期
            }
            return now - playlist.createdAt < temporaryExpiry;
        });
        
        // 检查同时活跃播放列表数量限制
        if (userLimit.activePlaylists.length >= maxSimultaneous) {
            return {
                allowed: false,
                reason: 'too_many_active_playlists',
                message: `您当前有 ${userLimit.activePlaylists.length} 个活跃播放列表，已达到最大限制（${maxSimultaneous}个）。请等待现有播放列表过期或删除后重试。`,
                activeCount: userLimit.activePlaylists.length,
                maxCount: maxSimultaneous
            };
        }
        
        // 如果账户已被禁用，检查是否需要解禁
        if (userLimit.disabled) {
            const timeSinceDisabled = now - userLimit.disabledAt;
            console.log(`⏰ User ${username} disabled ${Math.floor(timeSinceDisabled / 1000 / 60)} minutes ago`);
            
            if (timeSinceDisabled > limitPeriod) {
                // 超过限制周期，重置限制
                userLimit.requests = [];
                userLimit.disabled = false;
                userLimit.disabledAt = null;
                console.log(`🔓 Reset playlist limit for user ${username} after limit period`);
            } else {
                return {
                    allowed: false,
                    reason: 'account_disabled',
                    message: '您的账户因超过请求限制已被暂时禁用，请稍后重试或重新生成token。',
                    remainingTime: Math.ceil((limitPeriod - timeSinceDisabled) / 1000 / 60) // 剩余分钟数
                };
            }
        }
        
        // 清理限制周期前的请求记录
        const oldRequestsCount = userLimit.requests.length;
        userLimit.requests = userLimit.requests.filter(requestTime => now - requestTime < limitPeriod);
        if (oldRequestsCount !== userLimit.requests.length) {
            console.log(`🧹 Cleaned ${oldRequestsCount - userLimit.requests.length} old requests for user ${username}`);
        }
        
        // 检查是否超过限制（仅对非永久用户）
        if (!userHistory.qualifiedForPermanent && userLimit.requests.length >= maxRequests) {
            // 超过限制，禁用账户
            userLimit.disabled = true;
            userLimit.disabledAt = now;
            
            console.log(`🚫 User ${username} exceeded playlist request limit (${userLimit.requests.length}/${maxRequests})`);
            
            // 发送Telegram通知
            await this.notifyUserLimitExceeded(user.telegramUserId, username);
            
            return {
                allowed: false,
                reason: 'limit_exceeded',
                message: '您已超过播放列表请求限制，账户已被暂时禁用。请重新生成token。'
            };
        }
        
        // 记录本次请求（仅对非永久用户）
        if (!userHistory.qualifiedForPermanent) {
            userLimit.requests.push(now);
        }
        
        // 更新用户历史
        this.updateUserPlaylistHistory(username);
        
        const remainingRequests = Math.max(0, maxRequests - userLimit.requests.length);
        const requestsUsed = userHistory.qualifiedForPermanent ? 0 : userLimit.requests.length;
        
        console.log(`📊 User ${username} playlist request: ${requestsUsed}/${maxRequests}, remaining: ${remainingRequests}, permanent: ${userHistory.qualifiedForPermanent}`);
        
        return { 
            allowed: true, 
            requestsUsed: requestsUsed,
            requestsRemaining: remainingRequests,
            isPermanentUser: userHistory.qualifiedForPermanent,
            activePlaylistCount: userLimit.activePlaylists.length,
            maxSimultaneous: maxSimultaneous
        };
    }
    
    // 新增：获取用户播放列表历史
    getUserPlaylistHistory(username) {
        let history = this.userPlaylistHistory.get(username);
        if (!history) {
            history = {
                totalRequests: 0,
                firstRequestTime: null,
                lastRequestTime: null,
                qualifiedForPermanent: false,
                qualificationTime: null
            };
            this.userPlaylistHistory.set(username, history);
        }
        return history;
    }
    
    // 新增：更新用户播放列表历史
    updateUserPlaylistHistory(username) {
        const history = this.getUserPlaylistHistory(username);
        const now = Date.now();
        
        history.totalRequests++;
        history.lastRequestTime = now;
        
        if (!history.firstRequestTime) {
            history.firstRequestTime = now;
        }
        
        // 检查是否符合永久播放列表条件
        const limitPeriod = this.config.playlist?.refreshLimitPeriod || 18000000; // 5小时
        const threshold = this.config.playlist?.permanentLinkThreshold || 5;
        const timeSinceFirst = now - history.firstRequestTime;
        
        if (!history.qualifiedForPermanent && 
            timeSinceFirst >= limitPeriod && 
            history.totalRequests < threshold) {
            
            history.qualifiedForPermanent = true;
            history.qualificationTime = now;
            
            console.log(`👑 User ${username} qualified for permanent playlists! (${history.totalRequests} requests in ${Math.floor(timeSinceFirst / 1000 / 60)} minutes)`);
            
            // 发送通知
            this.notifyUserPermanentQualification(username);
        }
        
        // 保存到持久化存储
        this.savePersistentStorage();
    }
    
    // 新增：通知用户获得永久播放列表资格
    async notifyUserPermanentQualification(username) {
        try {
            const user = this.users[username];
            if (!user?.telegramUserId || !this.telegramBot?.bot) {
                return;
            }
            
            const message = `
🎉 **恭喜！您已获得永久播放列表资格**

由于您使用习惯良好，没有频繁刷新播放列表，您现在享有以下特权：

✨ **永久有效链接**
- 您生成的播放列表链接永久有效
- 即使服务器重启也不会失效

📱 **多设备支持**
- 最多可同时拥有 ${this.config.playlist?.maxSimultaneousPlaylists || 3} 个有效播放列表
- 支持在不同设备上使用

🚀 **无刷新限制**
- 不再受播放列表刷新次数限制
- 可以根据需要重新生成播放列表

💡 **使用建议**
- 请继续保持良好的使用习惯
- 避免过度频繁地重新生成播放列表
- 在多设备间合理分配使用

感谢您的支持与配合！
            `;
            
            await this.telegramBot.bot.sendMessage(user.telegramUserId, message, { parse_mode: 'Markdown' });
            console.log(`📱 Sent permanent qualification notification to user ${username}`);
            
        } catch (error) {
            console.error(`Error sending permanent qualification notification to user ${username}:`, error.message);
        }
    }
    
    // 新增：检查用户是否在Telegram群组中
    async checkUserInTelegramGroup(telegramUserId) {
        try {
            if (!this.telegramBot || !this.telegramBot.bot) {
                return true; // 如果机器人不可用，暂时允许
            }
            
            const chatMember = await this.telegramBot.bot.getChatMember(this.config.telegram.groupId, telegramUserId);
            return chatMember.status !== 'left' && 
                   chatMember.status !== 'kicked' && 
                   chatMember.status !== 'banned';
        } catch (error) {
            console.error(`Error checking group membership for user ${telegramUserId}:`, error.message);
            return true; // 如果检查失败，暂时允许
        }
    }
    
    // 新增：发送超限通知到Telegram
    async notifyUserLimitExceeded(telegramUserId, username) {
        try {
            if (!this.telegramBot || !this.telegramBot.bot) {
                return;
            }
            
            const message = `
🚫 **播放列表请求限制已达上限**

您的账户 \`${username}\` 在5小时内已达到最大请求次数（2次）。

⚠️ **您的访问权限已被暂时禁用**

🔄 **解决方案：**
1. 等待5小时后自动恢复
2. 或者使用 /revoke 命令撤销当前凭据
3. 然后使用 /gettoken 命令重新生成token

💡 **建议：**
- 请避免频繁刷新播放列表
- 下载播放列表后请保存到本地使用
- 播放列表内容不会频繁变化，无需反复获取

如有疑问，请联系管理员。
            `;
            
            await this.telegramBot.bot.sendMessage(telegramUserId, message, { parse_mode: 'Markdown' });
            console.log(`📱 Sent limit exceeded notification to user ${telegramUserId}`);
            
        } catch (error) {
            console.error(`Error sending Telegram notification to user ${telegramUserId}:`, error.message);
        }
    }
    
    // 新增：清理过期的播放列表限制记录
    cleanupExpiredPlaylistLimits() {
        const now = Date.now();
        const fiveHours = 5 * 60 * 60 * 1000;
        let cleanedCount = 0;
        
        for (const [username, userLimit] of this.playlistRequestLimits.entries()) {
            // 清理过期的请求记录
            const oldRequestsLength = userLimit.requests.length;
            userLimit.requests = userLimit.requests.filter(requestTime => now - requestTime < fiveHours);
            
            // 如果账户被禁用超过5小时，重置状态
            if (userLimit.disabled && now - userLimit.disabledAt > fiveHours) {
                userLimit.disabled = false;
                userLimit.disabledAt = null;
                console.log(`🔓 Auto-reset playlist limit for user ${username}`);
            }
            
            // 如果记录已经完全过期且未被禁用，删除记录
            if (userLimit.requests.length === 0 && !userLimit.disabled) {
                this.playlistRequestLimits.delete(username);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`🧹 Cleaned up ${cleanedCount} expired playlist limit records`);
        }
    }
    
    // 新增：手动重置用户播放列表限制的方法（供管理员使用）
    resetUserPlaylistLimit(username) {
        if (this.playlistRequestLimits.has(username)) {
            this.playlistRequestLimits.delete(username);
            console.log(`🔧 Manually reset playlist limit for user ${username}`);
            return true;
        }
        return false;
    }
    
    // 修改播放列表生成方法
    async handleGetPlaylist(req, res) {
        const { username, password, type } = req.query;
        
        // 验证用户
        const auth = this.authenticateUser(username, password);
        if (!auth.success) {
            return res.status(401).send('Authentication failed');
        }
        
        // 检查播放列表请求限制
        const limitCheck = await this.checkPlaylistRequestLimit(username, req);
        if (!limitCheck.allowed) {
            console.log(`🚫 Playlist request denied for ${username}: ${limitCheck.reason}`);
            
            let statusCode = 429;
            let errorMessage = limitCheck.message;
            
            if (limitCheck.reason === 'user_not_in_group') {
                statusCode = 403;
            } else if (limitCheck.reason === 'too_many_active_playlists') {
                statusCode = 409; // Conflict
            }
            
            if (limitCheck.remainingTime) {
                errorMessage += ` 剩余时间：${limitCheck.remainingTime}分钟。`;
            }
            
            return res.status(statusCode).json({
                error: limitCheck.reason,
                message: errorMessage,
                remainingTime: limitCheck.remainingTime || null,
                activeCount: limitCheck.activeCount || null,
                maxCount: limitCheck.maxCount || null
            });
        }
        
        const isPermanent = limitCheck.isPermanentUser;
        const playlistId = this.generatePlaylistId(username);
        
        console.log(`📋 Generating ${isPermanent ? 'permanent' : 'temporary'} encrypted playlist for user ${username} (${this.channels.length} channels) - Active: ${limitCheck.activePlaylistCount}/${limitCheck.maxSimultaneous}`);
        
        try {
            let m3uContent = '#EXTM3U\n';
            const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || '127.0.0.1';
            
            // 确定链接有效期
            const expiryMinutes = isPermanent ? 
                Math.floor((this.config.playlist?.permanentLinkExpiry || 31536000000) / 60000) : // 默认1年
                Math.floor((this.config.playlist?.temporaryLinkExpiry || 7200000) / 60000); // 默认2小时
            
            for (const channel of this.channels) {
                // 生成加密token
                const encryptedToken = this.encryptChannelUrl(
                    channel.url, 
                    username, 
                    channel.id, 
                    clientIP,
                    expiryMinutes,
                    playlistId,
                    isPermanent
                );
                
                // 构建重定向URL
                const redirectUrl = `${req.protocol}://${req.get('host')}/redirect/${username}/${encryptedToken}`;
                
                m3uContent += `#EXTINF:-1 `;
                if (channel.tvg_id) m3uContent += `tvg-id="${channel.tvg_id}" `;
                if (channel.name) m3uContent += `tvg-name="${channel.name}" `;
                if (channel.logo) m3uContent += `tvg-logo="${channel.logo}" `;
                if (channel.group) m3uContent += `group-title="${channel.group}" `;
                m3uContent += `,${channel.name}\n`;
                m3uContent += `${redirectUrl}\n`;
            }
            
            // 记录活跃播放列表
            const userLimit = this.playlistRequestLimits.get(username);
            if (userLimit) {
                userLimit.activePlaylists.push({
                    id: playlistId,
                    createdAt: Date.now(),
                    isPermanent: isPermanent,
                    clientIP: clientIP
                });
            }
            
            // 如果是永久播放列表，保存到持久化存储
            if (isPermanent && this.config.playlist?.enablePersistentStorage) {
                this.persistentPlaylists.set(playlistId, {
                    username: username,
                    createdAt: Date.now(),
                    clientIP: clientIP,
                    channels: this.channels.length
                });
                this.savePersistentStorage();
            }
            
            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Content-Disposition', 'attachment; filename="playlist.m3u"');
            res.setHeader('X-Playlist-Type', isPermanent ? 'permanent' : 'temporary');
            res.setHeader('X-Playlist-ID', playlistId);
            res.setHeader('X-Token-Expiry', expiryMinutes.toString());
            res.setHeader('X-Active-Playlists', limitCheck.activePlaylistCount.toString());
            res.setHeader('X-Max-Playlists', limitCheck.maxSimultaneous.toString());
            
            if (!isPermanent) {
                res.setHeader('X-Requests-Remaining', limitCheck.requestsRemaining.toString());
            }
            
            res.send(m3uContent);
            
            console.log(`✅ ${isPermanent ? 'Permanent' : 'Temporary'} playlist generated for user ${username} (ID: ${playlistId})`);
            
        } catch (error) {
            console.error('❌ Error generating encrypted playlist:', error);
            res.status(500).send('Error generating playlist');
        }
    }
    
    // 新增：生成播放列表ID
    generatePlaylistId(username) {
        const crypto = require('crypto');
        const timestamp = Date.now();
        const random = crypto.randomBytes(4).toString('hex');
        return `${username}_${timestamp}_${random}`;
    }
    
    // 修改加密方法以支持永久链接
    encryptChannelUrl(originalUrl, username, channelId, clientIP, expiryMinutes = 120, playlistId = null, isPermanent = false) {
        const crypto = require('crypto');
        const currentTime = Date.now();
        const expiryTime = isPermanent ? 
            currentTime + (this.config.playlist?.permanentLinkExpiry || 31536000000) : // 默认1年
            currentTime + (expiryMinutes * 60 * 1000);
        
        const payload = {
            url: originalUrl,
            user: username,
            channel: channelId,
            ip: clientIP,
            issued: currentTime,
            expires: expiryTime,
            playlistId: playlistId,
            isPermanent: isPermanent,
            nonce: crypto.randomBytes(8).toString('hex')
        };
        
        try {
            const algorithm = 'aes-256-cbc';
            const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
            const iv = crypto.randomBytes(16);
            
            const cipher = crypto.createCipheriv(algorithm, key, iv);
            let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'hex');
            encrypted += cipher.final('hex');
            
            // 组合 IV 和加密数据
            const combined = iv.toString('hex') + ':' + encrypted;
            const base64Combined = Buffer.from(combined).toString('base64');
            
            // URL安全的base64编码
            return base64Combined.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
            
        } catch (error) {
            console.error('Encryption error:', error.message);
            throw new Error('Failed to encrypt channel URL');
        }
    }
    
    // 修改验证token载荷的方法
    validateTokenPayload(payload, username, clientIP, encryptedToken) {
        const currentTime = Date.now();
        
        // 如果是永久链接，检查是否在持久化存储中
        if (payload.isPermanent && payload.playlistId) {
            const persistentPlaylist = this.persistentPlaylists.get(payload.playlistId);
            if (!persistentPlaylist) {
                return { success: false, error: 'Permanent playlist not found', code: 'PLAYLIST_NOT_FOUND' };
            }
            
            // 永久链接不检查时效性，但仍然检查其他条件
        } else {
            // 验证时效性（非永久链接）
            if (currentTime > payload.expires) {
                return { success: false, error: 'Token expired', code: 'EXPIRED' };
            }
        }
        
        // 验证用户身份
        if (payload.user !== username) {
            return { success: false, error: 'Invalid user', code: 'USER_MISMATCH' };
        }
        
        // 验证IP（可选，根据配置决定）
        if (this.config.security?.enableIPBinding && payload.ip !== clientIP) {
            return { success: false, error: 'IP mismatch', code: 'IP_MISMATCH' };
        }
        
        // 检查使用次数限制（永久链接有更高的限制）
        const tokenKey = `${username}_${encryptedToken}`;
        const usageLimit = payload.isPermanent ? 
            (this.config.security?.maxTokenUsage || 3) * 10 : // 永久链接10倍限制
            (this.config.security?.maxTokenUsage || 3);
        
        const usageCount = this.redirectTokens.get(tokenKey) || 0;
        if (usageCount >= usageLimit) {
            return { success: false, error: 'Token usage limit exceeded', code: 'USAGE_LIMIT' };
        }
        
        const remainingTime = payload.isPermanent ? 
            Infinity : 
            Math.floor((payload.expires - currentTime) / 60000);
        
        return { 
            success: true, 
            url: payload.url, 
            channel: payload.channel,
            tokenKey: tokenKey,
            remainingTime: remainingTime,
            isPermanent: payload.isPermanent || false,
            playlistId: payload.playlistId
        };
    }
    
    // 新增：清理过期的持久化播放列表
    cleanupExpiredPersistentPlaylists() {
        if (!this.config.playlist?.enablePersistentStorage) {
            return;
        }
        
        const now = Date.now();
        const maxAge = this.config.playlist?.permanentLinkExpiry || 31536000000; // 默认1年
        let cleanedCount = 0;
        
        for (const [playlistId, playlist] of this.persistentPlaylists.entries()) {
            if (now - playlist.createdAt > maxAge) {
                this.persistentPlaylists.delete(playlistId);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`🧹 Cleaned up ${cleanedCount} expired persistent playlists`);
            this.savePersistentStorage();
        }
    }
    
    // 修改状态处理以包含新的统计信息
    handleStatus(req, res) {
        // 安全检查
        if (!this.channels) this.channels = [];
        if (!this.categories) this.categories = [];
        if (!this.users) this.users = {};
        if (!this.telegramUsers) this.telegramUsers = new Map();

        const telegramUserCount = this.telegramUsers.size;
        const configUserCount = Object.keys(this.config.users || {}).length;
        
        const existingResponse = {
            service: 'Xtream Codes Encrypted Redirect Proxy',
            status: 'running',
            mode: 'encrypted_redirect_with_persistence',
            uptime: process.uptime(),
            memory_usage: process.memoryUsage(),
            server: {
                port: this.port,
                original_server: this.originalServer.url
            },
            channels: {
                total: this.channels.length,
                categories: this.categories.length
            },
            users: {
                config_users: configUserCount,
                telegram_users: telegramUserCount,
                total_active: configUserCount + telegramUserCount,
                permanent_qualified: Array.from(this.userPlaylistHistory.values()).filter(h => h.qualifiedForPermanent).length
            },
            playlists: {
                persistent_playlists: this.persistentPlaylists.size,
                max_simultaneous: this.config.playlist?.maxSimultaneousPlaylists || 3,
                refresh_limit_period: Math.floor((this.config.playlist?.refreshLimitPeriod || 18000000) / 3600000) + ' hours',
                max_refreshes: this.config.playlist?.maxRefreshesInPeriod || 5,
                permanent_threshold: this.config.playlist?.permanentLinkThreshold || 5
            },
            security: {
                encrypted_redirects: true,
                active_tokens: this.redirectTokens.size,
                token_usage_limit: this.tokenUsageLimit,
                ip_binding_enabled: this.config.security?.enableIPBinding || false,
                persistent_storage: this.config.playlist?.enablePersistentStorage || false
            },
            telegram_bot: {
                enabled: this.config.features?.enableTelegramBot || false,
                active: !!this.telegramBot
            },
            note: 'Enhanced encrypted redirect mode with persistent playlists and multi-device support.'
        };
        
        res.json(existingResponse);
    }
    
    // 处理用户管理
    handleUserManagement(req, res) {
        // 这里可以添加用户管理功能
        res.json({ message: 'User management endpoint - coming soon' });
    }
    
    start() {
        this.server = this.app.listen(this.port, this.config.server.host, () => {
            console.log(`🚀 Xtream Codes Proxy Server running on ${this.config.server.host}:${this.port}`);
            console.log(`📺 Original server: ${this.originalServer.url}`);
            console.log(`👥 Config users: ${Object.keys(this.config.users).length}`);
            console.log(`📱 Telegram users: ${this.telegramUsers.size}`);
            console.log(`🔗 Total channels: ${this.channels.length}`);
            
            if (this.config.features.enableTelegramBot) {
                console.log(`🤖 Telegram bot: ${this.telegramBot && this.telegramBot.bot ? '✅ Active' : '❌ Inactive'}`);
            }
            
            console.log(`\n📋 Available endpoints:`);
            console.log(`   🌐 Server info: http://${this.config.server.host}:${this.port}/`);
            console.log(`   📊 Status: http://${this.config.server.host}:${this.port}/status`);
            console.log(`   🎬 Player API: http://${this.config.server.host}:${this.port}/player_api.php`);
            console.log(`   📺 M3U Playlist: http://${this.config.server.host}:${this.port}/get.php`);
            
            if (this.config.features.enableAdmin) {
                console.log(`   ⚙️  Admin panel: http://${this.config.server.host}:${this.port}/admin`);
            }
        });
    }

    // 添加一个空的 cleanupConnections 方法以保持兼容性（如果其他地方还在调用）
    cleanupConnections() {
        // 在认证模式下不需要清理连接，因为我们不跟踪连接
        // 保留空方法以防其他地方还在调用
    }

    // 新增：处理Player API请求
    async handlePlayerApi(req, res) {
        const { username, password, action, stream_id } = req.query;
        
        // 验证用户
        const auth = this.authenticateUser(username, password);
        if (!auth.success) {
            return res.status(401).json({ error: 'Authentication failed' });
        }
        
        switch (action) {
            case 'get_live_categories':
                res.json(this.categories);
                break;
                
            case 'get_live_streams':
                if (stream_id) {
                    // 获取特定流信息
                    const channel = this.channels.find(ch => ch.id === stream_id);
                    if (channel) {
                        res.json([{
                            num: channel.id,
                            name: channel.name,
                            stream_type: 'live',
                            stream_id: channel.id,
                            stream_icon: channel.logo || '',
                            epg_channel_id: channel.tvg_id || '',
                            added: Math.floor(Date.now() / 1000),
                            category_id: channel.category_id || '1',
                            custom_sid: '',
                            tv_archive: 0,
                            direct_source: channel.url, // 直接返回原始链接
                            tv_archive_duration: 0
                        }]);
                    } else {
                        res.status(404).json({ error: 'Stream not found' });
                    }
                } else {
                    // 获取所有直播流 - 使用原始链接
                    const streams = this.channels.map(channel => ({
                        num: channel.id,
                        name: channel.name,
                        stream_type: 'live',
                        stream_id: channel.id,
                        stream_icon: channel.logo || '',
                        epg_channel_id: channel.tvg_id || '',
                        added: Math.floor(Date.now() / 1000),
                        category_id: channel.category_id || '1',
                        custom_sid: '',
                        tv_archive: 0,
                        direct_source: channel.url, // 直接返回原始链接
                        tv_archive_duration: 0
                    }));
                    
                    res.json(streams);
                }
                break;
                
            case 'get_vod_categories':
                res.json([]);
                break;
                
            case 'get_vod_streams':
                res.json([]);
                break;
                
            case 'get_series_categories':
                res.json([]);
                break;
                
            case 'get_series':
                res.json([]);
                break;
                
            default:
                // 返回用户信息
                res.json({
                    user_info: {
                        username: username,
                        password: password,
                        message: 'Welcome to Xtream Codes Authentication Proxy',
                        auth: 1,
                        status: 'Active',
                        exp_date: '1999999999',
                        is_trial: '0',
                        active_cons: '0', // 不再跟踪连接数，因为不代理流
                        created_at: Math.floor(auth.user.createdAt.getTime() / 1000),
                        max_connections: auth.user.maxConnections.toString(),
                        allowed_output_formats: ['m3u8', 'ts']
                    },
                    server_info: {
                        url: req.protocol + '://' + req.get('host'),
                        port: this.port.toString(),
                        https_port: '',
                        server_protocol: req.protocol,
                        rtmp_port: '',
                        timezone: 'UTC',
                        timestamp_now: Math.floor(Date.now() / 1000),
                        time_now: new Date().toISOString()
                    }
                });
                break;
        }
    }

    // 生成固定的加密密钥（基于配置生成，重启后保持一致）
    generateEncryptionKey() {
        const crypto = require('crypto');
        // 基于配置文件内容生成固定密钥，确保重启后密钥一致
        const configString = JSON.stringify(this.config.originalServer) + this.config.server.port;
        return crypto.createHash('sha256').update(configString).digest('hex');
    }
    
    // 新增：token清理任务
    startTokenCleanup() {
        setInterval(() => {
            const now = Date.now();
            let cleanedCount = 0;
            
            // 清理过期的token使用记录（保留24小时）
            const maxAge = 24 * 60 * 60 * 1000; // 24小时
            
            for (const [tokenKey, timestamp] of this.redirectTokens.entries()) {
                if (typeof timestamp === 'number' && now - timestamp > maxAge) {
                    this.redirectTokens.delete(tokenKey);
                    cleanedCount++;
                }
            }
            
            if (cleanedCount > 0) {
                console.log(`🧹 Cleaned up ${cleanedCount} expired token records`);
            }
        }, 30 * 60 * 1000); // 每30分钟清理一次
    }

    // 新增：处理加密重定向
    async handleEncryptedRedirect(req, res) {
        const { username, token } = req.params;
        const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || '127.0.0.1';
        
        // 解密并验证token
        const decryption = this.decryptChannelToken(token, username, clientIP);
        if (!decryption.success) {
            console.log(`🚫 Invalid redirect token for user ${username} from IP ${clientIP}: ${decryption.error}`);
            
            // 根据错误类型返回不同的响应
            let statusCode = 403;
            let message = '链接验证失败';
            
            switch (decryption.code) {
                case 'EXPIRED':
                    statusCode = 410; // Gone
                    message = '链接已过期，请重新获取播放列表';
                    break;
                case 'USER_MISMATCH':
                    statusCode = 403;
                    message = '用户验证失败';
                    break;
                case 'IP_MISMATCH':
                    statusCode = 403;
                    message = 'IP地址验证失败';
                    break;
                case 'USAGE_LIMIT':
                    statusCode = 429;
                    message = '链接使用次数超限，请重新获取播放列表';
                    break;
                case 'PLAYLIST_NOT_FOUND':
                    statusCode = 410;
                    message = '播放列表已过期，请重新获取';
                    break;
                default:
                    statusCode = 400;
                    message = '链接格式无效';
            }
            
            return res.status(statusCode).json({
                error: decryption.code,
                message: message
            });
        }
        
        // 记录token使用次数
        const currentUsage = this.redirectTokens.get(decryption.tokenKey) || 0;
        this.redirectTokens.set(decryption.tokenKey, currentUsage + 1);
        
        const timeInfo = decryption.isPermanent ? 
            'permanent' : 
            `${decryption.remainingTime} min remaining`;
        
        console.log(`🔗 Redirecting user ${username} to channel ${decryption.channel} (${timeInfo}, usage: ${currentUsage + 1})`);
        
        // 302重定向到原始链接 - 流量直接走用户本地
        res.redirect(302, decryption.url);
    }

    // 新增：处理XMLTV EPG
    async handleXMLTV(req, res) {
        const { username, password } = req.query;
        
        // 验证用户
        const auth = this.authenticateUser(username, password);
        if (!auth.success) {
            return res.status(401).send('Authentication failed');
        }
        
        // 基本的XMLTV文件
        const xmltvContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
${this.channels.map(channel => 
    `  <channel id="${channel.tvg_id || channel.id}">
    <display-name>${channel.name}</display-name>
  </channel>`
).join('\n')}
</tv>`;
        
        res.setHeader('Content-Type', 'application/xml');
        res.send(xmltvContent);
    }

    // 新增：处理直播流代理（改进版）
    async handleLiveStream(req, res) {
        const { username, password, streamId, ext } = req.params;
        
        // 验证用户
        const auth = this.authenticateUser(username, password);
        if (!auth.success) {
            return res.status(401).send('Authentication failed');
        }

        // 查找频道
        const channel = this.channels.find(ch => ch.id === streamId);
        if (!channel) {
            return res.status(404).send('Stream not found');
        }

        console.log(`🔗 Redirecting user ${username} to original stream: ${channel.name}`);
        
        // 直接重定向到原始链接
        res.redirect(302, channel.url);
    }

    // 新增：处理管理面板
    handleAdminPanel(req, res) {
        // 安全检查，确保所有必要的属性都已初始化
        if (!this.channels) this.channels = [];
        if (!this.categories) this.categories = [];
        if (!this.users) this.users = {};
        if (!this.telegramUsers) this.telegramUsers = new Map();
        
        const html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Xtream Codes Enhanced Proxy - 管理面板</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh; padding: 20px; color: #333;
                }
                .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 15px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.1); }
                .header { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 30px; text-align: center; }
                .header h1 { font-size: 2.5rem; margin-bottom: 10px; }
                .mode-badge { background: rgba(255,255,255,0.2); padding: 5px 15px; border-radius: 20px; font-size: 0.9rem; }
                .content { padding: 30px; }
                .section { background: #f8f9fa; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
                .section h2 { color: #2c3e50; margin-bottom: 15px; }
                table { width: 100%; border-collapse: collapse; margin: 15px 0; }
                th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
                th { background-color: #f2f2f2; font-weight: 600; }
                .status-active { color: #28a745; font-weight: 600; }
                .status-inactive { color: #6c757d; }
                .url-box { background: #e9ecef; padding: 10px; border-radius: 6px; font-family: monospace; font-size: 12px; margin: 5px 0; word-break: break-all; }
                .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
                .stat-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; text-align: center; }
                .stat-value { font-size: 2rem; font-weight: bold; }
                .stat-label { opacity: 0.9; }
                .refresh-btn { background: #28a745; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; }
                .refresh-btn:hover { background: #218838; }
                .warning-box { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 8px; margin: 15px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🎬 Xtream Codes Enhanced Proxy</h1>
                    <div class="mode-badge">🔐 增强模式 - 永久链接 + 多设备支持</div>
                    <p>管理面板</p>
                </div>
                
                <div class="content">
                    <div class="warning-box">
                        <strong>✨ 新功能:</strong> 支持永久有效链接、多设备同时使用、智能请求限制管理。
                    </div>

                    <div class="stats">
                        <div class="stat-card">
                            <div class="stat-value">${this.channels.length}</div>
                            <div class="stat-label">频道数量</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value">${this.categories.length}</div>
                            <div class="stat-label">分类数量</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value">${Object.keys(this.users).length}</div>
                            <div class="stat-label">总用户数</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value">${this.telegramUsers.size}</div>
                            <div class="stat-label">Telegram用户</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value">${this.persistentPlaylists ? this.persistentPlaylists.size : 0}</div>
                            <div class="stat-label">永久播放列表</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value">${this.userPlaylistHistory ? Array.from(this.userPlaylistHistory.values()).filter(h => h.qualifiedForPermanent).length : 0}</div>
                            <div class="stat-label">永久用户</div>
                        </div>
                    </div>

                    <div class="section">
                        <h2>👥 用户管理</h2>
                        <table>
                            <thead>
                                <tr>
                                    <th>用户名</th>
                                    <th>密码</th>
                                    <th>最大连接数</th>
                                    <th>最后活动</th>
                                    <th>状态</th>
                                    <th>永久资格</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${Object.entries(this.users).map(([username, user]) => {
                                    const history = this.userPlaylistHistory ? this.userPlaylistHistory.get(username) : null;
                                    const isPermanent = history ? history.qualifiedForPermanent : false;
                                    return `
                                        <tr>
                                            <td>${username}</td>
                                            <td>${user.password.substring(0, 8)}...</td>
                                            <td>${user.maxConnections}</td>
                                            <td>${user.lastActivity ? new Date(user.lastActivity).toLocaleString('zh-CN') : '从未'}</td>
                                            <td><span class="status-active">● 在线</span></td>
                                            <td>${isPermanent ? '<span class="status-active">👑 永久</span>' : '<span class="status-inactive">⏳ 临时</span>'}</td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>

                    <div class="section">
                        <h2>🔗 服务端点</h2>
                        <div class="url-box">🌐 服务器地址: http://${req.get('host')}</div>
                        <div class="url-box">📊 状态监控: http://${req.get('host')}/status</div>
                        <div class="url-box">🎬 Player API: http://${req.get('host')}/player_api.php</div>
                        <div class="url-box">📺 M3U播放列表: http://${req.get('host')}/get.php</div>
                        <div class="url-box">📺 XMLTV EPG: http://${req.get('host')}/xmltv.php</div>
                    </div>

                    <div class="section">
                        <h2>📡 原始服务器</h2>
                        <div class="url-box">🔗 ${this.originalServer.url}${this.originalServer.m3uPath}</div>
                        <p><strong>注意:</strong> 流媒体内容直接从上述原始服务器提供。</p>
                    </div>

                    <div class="section">
                        <h2>⚙️ 配置信息</h2>
                        <p><strong>最大同时播放列表:</strong> ${this.config.playlist?.maxSimultaneousPlaylists || 3}</p>
                        <p><strong>刷新限制周期:</strong> ${Math.floor((this.config.playlist?.refreshLimitPeriod || 18000000) / 3600000)} 小时</p>
                        <p><strong>周期内最大刷新次数:</strong> ${this.config.playlist?.maxRefreshesInPeriod || 5}</p>
                        <p><strong>永久资格阈值:</strong> ${this.config.playlist?.permanentLinkThreshold || 5} 次以下</p>
                    </div>

                    <button class="refresh-btn" onclick="location.reload()">🔄 刷新页面</button>
                </div>
            </div>
        </body>
        </html>
        `;
        
        res.send(html);
    }

    // 新增：解密并验证token的方法
    decryptChannelToken(encryptedToken, username, clientIP) {
        try {
            const crypto = require('crypto');
            
            // 还原URL安全的base64编码
            let base64Token = encryptedToken.replace(/-/g, '+').replace(/_/g, '/');
            while (base64Token.length % 4) {
                base64Token += '=';
            }
            
            const combined = Buffer.from(base64Token, 'base64').toString('utf8');
            const parts = combined.split(':');
            
            if (parts.length !== 2) {
                return { success: false, error: 'Invalid token format', code: 'INVALID_FORMAT' };
            }
            
            const algorithm = 'aes-256-cbc';
            const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
            const iv = Buffer.from(parts[0], 'hex');
            const encryptedData = parts[1];
            
            const decipher = crypto.createDecipheriv(algorithm, key, iv);
            let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            
            const payload = JSON.parse(decrypted);
            
            // 验证token
            return this.validateTokenPayload(payload, username, clientIP, encryptedToken);
            
        } catch (error) {
            console.error('Token decryption error:', error.message);
            return { success: false, error: 'Invalid token format', code: 'INVALID_FORMAT' };
        }
    }

    // 新增：加载频道列表
    async loadChannels() {
        try {
            console.log('📡 Loading channels from original server...');
            const response = await axios.get(`${this.originalServer.url}${this.originalServer.m3uPath}`, {
                timeout: this.originalServer.timeout,
                headers: {
                    'User-Agent': 'Xtream-Codes-Proxy/1.0'
                }
            });
            
            this.parseM3UContent(response.data);
            console.log(`✅ Loaded ${this.channels.length} channels from ${this.categories.length} categories`);
            
        } catch (error) {
            console.error('❌ Error loading channels:', error.message);
            // 创建示例频道以供测试
            this.createSampleChannels();
        }
    }

    // 新增：解析M3U内容
    parseM3UContent(content) {
        const lines = content.split('\n').map(line => line.trim());
        const channels = [];
        const categories = new Set();
        let filteredCount = 0;
        
        // 获取过滤配置
        const filterConfig = this.config.features?.filterChannels || { enabled: false };
        const blacklistKeywords = filterConfig.blacklistKeywords || [];
        const whitelistKeywords = filterConfig.whitelistKeywords || [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (line.startsWith('#EXTINF:')) {
                if (i + 1 < lines.length) {
                    const url = lines[i + 1].trim();
                    if (url && !url.startsWith('#')) {
                        
                        // 解析频道信息
                        const titleMatch = line.match(/,\s*(.+)$/);
                        const title = titleMatch ? titleMatch[1] : `Channel ${channels.length + 1}`;
                        
                        // 应用过滤规则
                        if (filterConfig.enabled) {
                            let shouldFilter = false;
                            
                            // 检查黑名单关键词
                            for (const keyword of blacklistKeywords) {
                                if (title.includes(keyword)) {
                                    console.log(`🚫 Filtered channel (blacklist "${keyword}"): ${title}`);
                                    shouldFilter = true;
                                    filteredCount++;
                                    break;
                                }
                            }
                            
                            // 如果有白名单，检查是否在白名单中
                            if (!shouldFilter && whitelistKeywords.length > 0) {
                                const inWhitelist = whitelistKeywords.some(keyword => title.includes(keyword));
                                if (!inWhitelist) {
                                    console.log(`🚫 Filtered channel (not in whitelist): ${title}`);
                                    shouldFilter = true;
                                    filteredCount++;
                                }
                            }
                            
                            if (shouldFilter) {
                                i++; // 跳过URL行
                                continue; // 跳过这个频道
                            }
                        }
                        
                        const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
                        const tvgId = tvgIdMatch ? tvgIdMatch[1] : '';
                        
                        const groupMatch = line.match(/group-title="([^"]*)"/);
                        const group = groupMatch ? groupMatch[1] : 'General';
                        
                        const logoMatch = line.match(/tvg-logo="([^"]*)"/);
                        const logo = logoMatch ? logoMatch[1] : '';
                        
                        categories.add(group);
                        
                        channels.push({
                            id: (channels.length + 1).toString(),
                            name: title,
                            url: url,
                            tvg_id: tvgId,
                            group: group,
                            logo: logo,
                            category_id: Array.from(categories).indexOf(group) + 1
                        });
                        
                        i++; // 跳过URL行
                    }
                }
            }
        }
        
        this.channels = channels;
        this.categories = Array.from(categories).map((cat, index) => ({
            category_id: (index + 1).toString(),
            category_name: cat,
            parent_id: 0
        }));
        
        // 输出过滤统计信息
        if (filteredCount > 0) {
            console.log(`🧹 Filtered out ${filteredCount} channels based on filter rules`);
        }
    }

    // 新增：创建示例频道
    createSampleChannels() {
        console.log('⚠️  Creating sample channels for testing...');
        this.channels = [
            {
                id: '1',
                name: 'Test Channel 1',
                url: `${this.originalServer.url}${this.originalServer.m3uPath}`,
                tvg_id: 'test1',
                group: 'Test',
                logo: '',
                category_id: '1'
            }
        ];
        
        this.categories = [
            {
                category_id: '1',
                category_name: 'Test',
                parent_id: 0
            }
        ];
    }

    // 新增：启动原始服务器自动刷新任务
    startOriginalServerAutoRefresh() {
        if (!this.config.originalServer?.enableAutoRefresh) {
            console.log('🔄 Original server auto-refresh is disabled');
            return;
        }
        
        const interval = this.config.originalServer.autoRefreshInterval || 7200000; // 默认2小时
        
        console.log(`🔄 Starting original server auto-refresh every ${interval/1000/60} minutes`);
        
        setInterval(async () => {
            try {
                console.log('🔄 Auto-refreshing original server channels...');
                await this.loadChannels();
                console.log('✅ Original server channels auto-refreshed successfully');
                
                // 通知所有管理员（如果有Telegram机器人）
                if (this.telegramBot) {
                    const adminIds = this.telegramBot.getAllAdminIds();
                    for (const adminId of adminIds) {
                        try {
                            await this.telegramBot.bot.sendMessage(
                                adminId,
                                `🔄 **系统自动刷新**\n\n📺 原始服务器频道列表已自动刷新\n⏰ 时间: ${new Date().toLocaleString('zh-CN')}\n📊 频道数量: ${this.channels.length}`,
                                { parse_mode: 'Markdown' }
                            );
                        } catch (error) {
                            console.warn(`Could not notify admin ${adminId}:`, error.message);
                        }
                    }
                }
            } catch (error) {
                console.error('❌ Error during auto-refresh:', error);
                
                // 通知所有管理员刷新失败
                if (this.telegramBot) {
                    const adminIds = this.telegramBot.getAllAdminIds();
                    for (const adminId of adminIds) {
                        try {
                            await this.telegramBot.bot.sendMessage(
                                adminId,
                                `❌ **自动刷新失败**\n\n🔧 原始服务器频道列表自动刷新失败\n⏰ 时间: ${new Date().toLocaleString('zh-CN')}\n🚫 错误: ${error.message}`,
                                { parse_mode: 'Markdown' }
                            );
                        } catch (notifyError) {
                            console.warn(`Could not notify admin ${adminId}:`, notifyError.message);
                        }
                    }
                }
            }
        }, interval);
    }

    // 新增：手动刷新原始服务器（供管理员使用）
    async refreshOriginalServer() {
        try {
            console.log('🔄 Manually refreshing original server channels...');
            await this.loadChannels();
            console.log('✅ Original server channels refreshed successfully');
            
            // 准备频道和分类样本
            const channelSample = this.channels.map(channel => ({
                name: channel.name,
                group: channel.group
            }));
            
            const categorySample = this.categories.map(category => ({
                name: category.category_name
            }));
            
            return {
                success: true,
                channelCount: this.channels.length,
                categoryCount: this.categories.length,
                refreshTime: new Date().toLocaleString('zh-CN'),
                channelSample: channelSample,
                categorySample: categorySample
            };
        } catch (error) {
            console.error('❌ Error during manual refresh:', error);
            return {
                success: false,
                error: error.message,
                refreshTime: new Date().toLocaleString('zh-CN'),
                channelSample: [],
                categorySample: []
            };
        }
    }
}

// 启动服务器
const proxy = new XtreamCodesProxy();
proxy.start();

module.exports = XtreamCodesProxy;