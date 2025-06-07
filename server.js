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
        
        // 初始化Telegram机器人
        this.telegramBot = new TelegramBotManager(this.config, this);
        
        // 存储解析后的频道列表
        this.channels = [];
        this.categories = [];
        
        // 保留连接管理对象（即使不使用，也保持兼容性）
        this.activeConnections = new Map();
        
        this.setupMiddleware();
        this.setupRoutes();
        this.loadChannels();
        
        // 定期刷新频道列表
        if (this.config.features.channelRefreshInterval > 0) {
            setInterval(() => this.loadChannels(), this.config.features.channelRefreshInterval);
        }
        
        // 新增：定期清理过期的请求限制记录
        setInterval(() => this.cleanupExpiredPlaylistLimits(), 300000); // 每5分钟清理一次
        
        // 启动Telegram机器人所有定时任务
        if (this.telegramBot) {
            this.telegramBot.startAllTasks();
        }
        
        // 设置优雅关闭处理
        this.setupGracefulShutdown();
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
        
        // 直播流重定向（可选，主要用于兼容性）
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
        
        // XMLTV EPG (可选)
        this.app.get('/xmltv.php', this.handleXMLTV.bind(this));
        
        // 根路径
        this.app.get('/', (req, res) => {
            res.json({
                service: 'Xtream Codes Authentication Proxy',
                version: '1.0.0',
                status: 'running',
                mode: 'authentication_only',
                channels: this.channels.length,
                description: 'This server only provides authentication. Streams are served directly from original sources.',
                endpoints: {
                    player_api: '/player_api.php',
                    playlist: '/get.php',
                    xmltv: '/xmltv.php',
                    admin: '/admin',
                    status: '/status'
                },
                usage: {
                    server_url: `${req.protocol}://${req.get('host')}`,
                    username: 'your_username',
                    password: 'your_password',
                    note: 'After authentication, streams will be served directly from original sources'
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
        const fiveHours = 5 * 60 * 60 * 1000; // 5小时毫秒数
        const maxRequests = 2; // 最大请求次数
        
        // 获取或创建用户的请求限制记录
        let userLimit = this.playlistRequestLimits.get(username);
        if (!userLimit) {
            userLimit = {
                requests: [],
                disabled: false,
                disabledAt: null,
                createdAt: now // 添加创建时间用于调试
            };
            this.playlistRequestLimits.set(username, userLimit);
            console.log(`🆕 Created new playlist limit record for user ${username}`);
        }
        
        // 如果账户已被禁用，检查是否需要解禁
        if (userLimit.disabled) {
            const timeSinceDisabled = now - userLimit.disabledAt;
            console.log(`⏰ User ${username} disabled ${Math.floor(timeSinceDisabled / 1000 / 60)} minutes ago`);
            
            if (timeSinceDisabled > fiveHours) {
                // 超过5小时，重置限制
                userLimit.requests = [];
                userLimit.disabled = false;
                userLimit.disabledAt = null;
                console.log(`🔓 Reset playlist limit for user ${username} after 5 hours`);
            } else {
                return {
                    allowed: false,
                    reason: 'account_disabled',
                    message: '您的账户因超过请求限制已被暂时禁用，请稍后重试或重新生成token。',
                    remainingTime: Math.ceil((fiveHours - timeSinceDisabled) / 1000 / 60) // 剩余分钟数
                };
            }
        }
        
        // 清理5小时前的请求记录
        const oldRequestsCount = userLimit.requests.length;
        userLimit.requests = userLimit.requests.filter(requestTime => now - requestTime < fiveHours);
        if (oldRequestsCount !== userLimit.requests.length) {
            console.log(`🧹 Cleaned ${oldRequestsCount - userLimit.requests.length} old requests for user ${username}`);
        }
        
        // 检查是否超过限制
        if (userLimit.requests.length >= maxRequests) {
            // 超过限制，禁用账户
            userLimit.disabled = true;
            userLimit.disabledAt = now;
            
            console.log(`🚫 User ${username} exceeded playlist request limit (${userLimit.requests.length}/${maxRequests})`);
            
            // 发送Telegram通知
            await this.notifyUserLimitExceeded(user.telegramUserId, username);
            
            return {
                allowed: false,
                reason: 'limit_exceeded',
                message: '您已超过播放列表请求限制（5小时内最多2次），账户已被暂时禁用。请重新生成token。'
            };
        }
        
        // 记录本次请求
        userLimit.requests.push(now);
        
        const remainingRequests = maxRequests - userLimit.requests.length;
        console.log(`📊 User ${username} playlist request: ${userLimit.requests.length}/${maxRequests}, remaining: ${remainingRequests}`);
        
        return { 
            allowed: true, 
            requestsUsed: userLimit.requests.length,
            requestsRemaining: remainingRequests
        };
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
    
    // 修改后的播放列表处理方法
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
            }
            
            if (limitCheck.remainingTime) {
                errorMessage += ` 剩余时间：${limitCheck.remainingTime}分钟。`;
            }
            
            return res.status(statusCode).json({
                error: limitCheck.reason,
                message: errorMessage,
                remainingTime: limitCheck.remainingTime || null
            });
        }
        
        console.log(`📋 Generating playlist for user ${username} (${this.channels.length} channels) - Request ${limitCheck.requestsUsed}/2`);
        
        try {
            let m3uContent = '#EXTM3U\n';
            
            for (const channel of this.channels) {
                // 直接使用原始频道链接，不通过代理
                const streamUrl = channel.url;
                
                m3uContent += `#EXTINF:-1 `;
                if (channel.tvg_id) m3uContent += `tvg-id="${channel.tvg_id}" `;
                if (channel.name) m3uContent += `tvg-name="${channel.name}" `;
                if (channel.logo) m3uContent += `tvg-logo="${channel.logo}" `;
                if (channel.group) m3uContent += `group-title="${channel.group}" `;
                m3uContent += `,${channel.name}\n`;
                m3uContent += `${streamUrl}\n`;
            }
            
            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Content-Disposition', 'attachment; filename="playlist.m3u"');
            res.setHeader('X-Requests-Remaining', limitCheck.requestsRemaining.toString());
            res.send(m3uContent);
            
            console.log(`✅ Playlist generated successfully for user ${username} (${limitCheck.requestsRemaining} requests remaining)`);
            
        } catch (error) {
            console.error('❌ Error generating playlist:', error);
            res.status(500).send('Error generating playlist');
        }
    }
    
    // 处理XMLTV EPG
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
    
    // 处理直播流代理（改进版）
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
    
    // 加载频道列表
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
    
    // 更灵活的M3U内容解析方法 - 支持配置化过滤
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
    
    // 创建示例频道（当无法连接原始服务器时）
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
    
    // 处理管理面板
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
            <title>Xtream Codes Authentication Proxy - 管理面板</title>
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
                    <h1>🎬 Xtream Codes Authentication Proxy</h1>
                    <div class="mode-badge">🔐 认证模式 - 不代理流媒体</div>
                    <p>管理面板</p>
                </div>
                
                <div class="content">
                    <div class="warning-box">
                        <strong>⚠️ 重要说明:</strong> 此服务器运行在"仅认证"模式下。用户通过认证后，将直接从原始服务器获取流媒体内容，不会通过此代理服务器转发。
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
                                </tr>
                            </thead>
                            <tbody>
                                ${Object.entries(this.users).map(([username, user]) => `
                                    <tr>
                                        <td>${username}</td>
                                        <td>${user.password.substring(0, 8)}...</td>
                                        <td>${user.maxConnections}</td>
                                        <td>${user.lastActivity ? new Date(user.lastActivity).toLocaleString('zh-CN') : '从未'}</td>
                                        <td><span class="status-active">● 在线</span></td>
                                    </tr>
                                `).join('')}
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

                    <button class="refresh-btn" onclick="location.reload()">🔄 刷新页面</button>
                </div>
            </div>
        </body>
        </html>
        `;
        
        res.send(html);
    }
    
    // 修改状态处理以包含Telegram用户信息和持久化状态
    handleStatus(req, res) {
        // 安全检查
        if (!this.channels) this.channels = [];
        if (!this.categories) this.categories = [];
        if (!this.users) this.users = {};
        if (!this.telegramUsers) this.telegramUsers = new Map();

        const telegramUserCount = this.telegramUsers.size;
        const configUserCount = Object.keys(this.config.users || {}).length;
        
        res.json({
            service: 'Xtream Codes Authentication Proxy',
            status: 'running',
            mode: 'authentication_only',
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
                total_active: configUserCount + telegramUserCount
            },
            telegram_bot: {
                enabled: this.config.features?.enableTelegramBot || false,
                active: !!this.telegramBot
            },
            features: {
                admin_panel: this.config.features?.enableAdmin || false,
                status_page: this.config.features?.enableStatus || false,
                epg: this.config.features?.enableEPG || false
            },
            note: 'This server only provides authentication. Streams are served directly from original sources.'
        });
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
}

// 启动服务器
const proxy = new XtreamCodesProxy();
proxy.start();

module.exports = XtreamCodesProxy;