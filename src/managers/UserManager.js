const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class UserManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        
        this.users = {};
        this.telegramUsers = new Map();
        this.redirectTokens = new Map();
        this.persistentPlaylists = new Map();
        this.userPlaylistHistory = new Map();
        this.playlistRequestLimits = new Map();
        
        // 新增：用户使用限制追踪
        this.userHourlyLimits = new Map(); // 每小时刷新限制
        this.userDailyLimits = new Map();  // 每日获取限制
        this.activeStreams = new Map();    // 活跃流追踪
        this.streamConnections = new Map(); // 流连接计数
        
        this.dataDir = path.join(__dirname, '../../data');
        this.usersFile = path.join(this.dataDir, 'users.json');
        this.playlistsFile = path.join(this.dataDir, 'playlists.json');
        this.limitsFile = path.join(this.dataDir, 'user-limits.json');
        
        this.encryptionKey = this.generateEncryptionKey();
        this.channelManager = null;
        
        this.ensureDataDirectory();
    }

    ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    async initialize() {
        this.loadUsers();
        this.loadPersistentData();
        this.loadUserLimits();
        this.logger.info('✅ UserManager initialized');
    }

    loadUsers() {
        try {
            if (fs.existsSync(this.usersFile)) {
                const data = JSON.parse(fs.readFileSync(this.usersFile, 'utf8'));
                this.users = data;
                this.logger.info(`Loaded ${Object.keys(this.users).length} users`);
            }
        } catch (error) {
            this.logger.error('Error loading users:', error);
        }
    }

    loadPersistentData() {
        try {
            if (fs.existsSync(this.playlistsFile)) {
                const data = JSON.parse(fs.readFileSync(this.playlistsFile, 'utf8'));
                
                if (data.persistentPlaylists) {
                    this.persistentPlaylists = new Map(Object.entries(data.persistentPlaylists));
                }
                
                if (data.userPlaylistHistory) {
                    this.userPlaylistHistory = new Map(Object.entries(data.userPlaylistHistory));
                }
                
                this.logger.info(`Loaded ${this.persistentPlaylists.size} persistent playlists`);
            }
        } catch (error) {
            this.logger.error('Error loading persistent data:', error);
        }
    }

    loadUserLimits() {
        try {
            if (fs.existsSync(this.limitsFile)) {
                const data = JSON.parse(fs.readFileSync(this.limitsFile, 'utf8'));
                
                if (data.hourlyLimits) {
                    this.userHourlyLimits = new Map(Object.entries(data.hourlyLimits));
                }
                
                if (data.dailyLimits) {
                    this.userDailyLimits = new Map(Object.entries(data.dailyLimits));
                }
                
                if (data.activeStreams) {
                    this.activeStreams = new Map(Object.entries(data.activeStreams));
                }
                
                this.logger.info(`Loaded user limits data`);
            }
        } catch (error) {
            this.logger.error('Error loading user limits:', error);
        }
    }

    saveUsers() {
        try {
            fs.writeFileSync(this.usersFile, JSON.stringify(this.users, null, 2));
        } catch (error) {
            this.logger.error('Error saving users:', error);
        }
    }

    savePersistentData() {
        try {
            const data = {
                persistentPlaylists: Object.fromEntries(this.persistentPlaylists),
                userPlaylistHistory: Object.fromEntries(this.userPlaylistHistory)
            };
            fs.writeFileSync(this.playlistsFile, JSON.stringify(data, null, 2));
        } catch (error) {
            this.logger.error('Error saving persistent data:', error);
        }
    }

    saveUserLimits() {
        try {
            const data = {
                hourlyLimits: Object.fromEntries(this.userHourlyLimits),
                dailyLimits: Object.fromEntries(this.userDailyLimits),
                activeStreams: Object.fromEntries(this.activeStreams)
            };
            fs.writeFileSync(this.limitsFile, JSON.stringify(data, null, 2));
        } catch (error) {
            this.logger.error('Error saving user limits:', error);
        }
    }

    authenticateUser(username, password) {
        const user = this.users[username];
        
        if (!user) {
            this.logger.warn(`Authentication failed: User ${username} not found`);
            return false;
        }
        
        if (!user.enabled) {
            this.logger.warn(`Authentication failed: User ${username} is disabled`);
            return false;
        }
        
        // 检查用户是否过期
        if (user.expiryTime && Date.now() > user.expiryTime) {
            this.logger.warn(`Authentication failed: User ${username} has expired`);
            // 禁用过期用户
            user.enabled = false;
            this.saveUsers();
            return false;
        }
        
        if (user.password !== password) {
            this.logger.warn(`Authentication failed: Invalid password for user ${username}`);
            return false;
        }
        
        this.logger.info(`User ${username} authenticated successfully`);
        return true;
    }

    createUser(username, password, options = {}) {
        const user = {
            password: password,
            enabled: true,
            createdAt: Date.now(),
            lastLogin: null,
            ...options
        };
        
        this.users[username] = user;
        this.saveUsers();
        
        this.logger.info(`User ${username} created successfully`);
        return user;
    }

    updateUser(username, updates) {
        if (!this.users[username]) {
            throw new Error('User not found');
        }
        
        this.users[username] = { ...this.users[username], ...updates };
        this.saveUsers();
        
        this.logger.info(`User ${username} updated successfully`);
        return this.users[username];
    }

    deleteUser(username) {
        if (!this.users[username]) {
            return false;
        }
        
        delete this.users[username];
        this.saveUsers();
        
        this.logger.info(`User ${username} deleted successfully`);
        return true;
    }

    createTelegramUser(username, password, telegramUserId) {
        const expiryTime = Date.now() + (this.config.playlist?.userLinkExpiry || 86400000); // 24小时后过期
        const user = this.createUser(username, password, {
            telegramUserId: telegramUserId,
            source: 'telegram',
            expiryTime: expiryTime,
            expiryNotified: false
        });
        
        this.telegramUsers.set(username, {
            telegramUserId: telegramUserId,
            username: username,
            createdAt: Date.now(),
            expiryTime: expiryTime
        });
        
        return user;
    }

    removeTelegramUser(username) {
        this.telegramUsers.delete(username);
        this.deleteUser(username);
    }

    // 检查每日令牌生成限制（已废弃，令牌限制现在由TokenManager处理）
    checkDailyTokenLimit(username) {
        // 这个方法已经不再使用，令牌限制由TokenManager处理
        // 保留此方法以防向后兼容性问题
        return true;
    }

    // 检查每小时播放列表刷新限制（用于限制播放列表链接访问频率）
    checkHourlyRefreshLimit(username) {
        const now = Date.now();
        const userLimit = this.userHourlyLimits.get(username);
        const maxHourlyRefresh = 10; // 每小时最多10次播放列表刷新
        const limitPeriod = 60 * 60 * 1000; // 1小时
        
        if (!userLimit) {
            this.userHourlyLimits.set(username, {
                count: 1,
                firstRefresh: now,
                resetTime: now + limitPeriod
            });
            this.saveUserLimits();
            return true;
        }
        
        // 检查是否需要重置
        if (now >= userLimit.resetTime) {
            this.userHourlyLimits.set(username, {
                count: 1,
                firstRefresh: now,
                resetTime: now + limitPeriod
            });
            this.saveUserLimits();
            return true;
        }
        
        if (userLimit.count >= maxHourlyRefresh) {
            return false;
        }
        
        userLimit.count++;
        this.saveUserLimits();
        return true;
    }

    // 检查流并发限制 - 修复并发检查逻辑
    checkStreamConcurrency(username, channelId, clientIP) {
        // 先清理不活跃的流（5分钟不活跃就清理）
        this.cleanupUserInactiveStreams(username);
        
        // 检查是否是同一设备访问同一频道（允许重复连接）
        const sessionKey = `${channelId}:${clientIP}`;
        for (const [streamId, stream] of this.activeStreams.entries()) {
            if (stream.username === username && 
                stream.channelId === channelId && 
                stream.clientIP === clientIP) {
                // 同一设备访问同一频道，更新最后活动时间并返回现有会话ID
                stream.lastActivity = Date.now();
                console.log(`🔄 ${username} 重用现有会话 ${channelId} from ${clientIP}`);
                return streamId;
            }
        }
        
        // 统计该用户当前的活跃流数量（去重计算设备数）
        const userDevices = new Set();
        for (const [streamId, stream] of this.activeStreams.entries()) {
            if (stream.username === username) {
                userDevices.add(stream.clientIP);
            }
        }
        
        console.log(`📊 ${username} 当前活跃设备数: ${userDevices.size}/3`);
        
        // 检查用户总并发限制（最大3个设备同时播放）
        if (userDevices.size >= 3 && !userDevices.has(clientIP)) {
            console.log(`⚠️  ${username} 设备并发限制超出: ${userDevices.size} 设备已在线`);
            this.showUserActiveStreams(username);
            return false;
        }
        
        // 记录新的活跃流
        const streamId = uuidv4();
        this.activeStreams.set(streamId, {
            username,
            channelId,
            clientIP,
            startTime: Date.now(),
            lastActivity: Date.now()
        });
        
        console.log(`✅ ${username} 新建流会话 ${channelId} from ${clientIP} (设备: ${userDevices.size + (userDevices.has(clientIP) ? 0 : 1)}/3)`);
        
        // 保持向后兼容的streamConnections结构（用于其他功能）
        const streamKey = `${username}:${channelId}`;
        const connections = this.streamConnections.get(streamKey) || new Set();
        connections.add(clientIP);
        this.streamConnections.set(streamKey, connections);
        
        this.saveUserLimits();
        return streamId;
    }

    // 清理特定用户的不活跃流
    cleanupUserInactiveStreams(username) {
        const now = Date.now();
        const inactiveThreshold = 5 * 60 * 1000; // 5分钟不活跃
        let cleanedCount = 0;
        
        for (const [streamId, stream] of this.activeStreams.entries()) {
            if (stream.username === username && now - stream.lastActivity > inactiveThreshold) {
                this.activeStreams.delete(streamId);
                cleanedCount++;
                console.log(`🧹 清理 ${username} 不活跃流: ${stream.channelId} from ${stream.clientIP}`);
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`🧹 ${username} 清理了 ${cleanedCount} 个不活跃流`);
        }
    }

    // 移除流连接
    removeStreamConnection(username, channelId, clientIP) {
        const streamKey = `${username}:${channelId}`;
        const connections = this.streamConnections.get(streamKey);
        
        if (connections) {
            connections.delete(clientIP);
            if (connections.size === 0) {
                this.streamConnections.delete(streamKey);
            } else {
                this.streamConnections.set(streamKey, connections);
            }
        }
        
        // 清理活跃流记录
        let removed = false;
        for (const [streamId, stream] of this.activeStreams.entries()) {
            if (stream.username === username && stream.channelId === channelId && stream.clientIP === clientIP) {
                this.activeStreams.delete(streamId);
                removed = true;
                console.log(`🗑️  ${username} 移除流连接: ${channelId} from ${clientIP}`);
                break;
            }
        }
        
        if (!removed) {
            console.log(`⚠️  ${username} 未找到要移除的流连接: ${channelId} from ${clientIP}`);
        }
        
        this.saveUserLimits();
    }

    async generatePlaylist(query, clientIP) {
        const { username, password, type = 'm3u' } = query;
        
        try {
            console.log(`📋 ${username} 请求播放列表 (${type})`);
            
            if (!this.authenticateUser(username, password)) {
                console.log(`❌ ${username} 认证失败`);
                throw new Error('Authentication failed');
            }
            
            // 检查每小时播放列表刷新限制
            if (!this.checkHourlyRefreshLimit(username)) {
                console.log(`⚠️  ${username} 超出每小时刷新限制`);
                throw new Error('Hourly playlist refresh limit exceeded (10 times per hour)');
            }
            
            // 生成播放列表逻辑
            const channels = await this.getChannelsForUser(username);
            
            // 检查是否有频道数据
            if (!channels || channels.length === 0) {
                console.log(`❌ ${username} 无可用频道`);
                this.logger.warn(`No channels available for user ${username}`);
                throw new Error('No channels available. Please contact administrator.');
            }
            
            console.log(`✅ ${username} 生成播放列表: ${channels.length}个频道`);
            this.logger.info(`Generating ${type} playlist for user ${username} with ${channels.length} channels`);
            
            if (type === 'm3u_plus') {
                return this.buildM3UPlusPlaylist(channels, username, clientIP);
            } else {
                return this.buildM3UPlaylist(channels, username, clientIP);
            }
        } catch (error) {
            console.error(`❌ ${username} 播放列表生成失败:`, error.message);
            this.logger.error(`Playlist generation failed for user ${username}:`, error.message);
            throw error;
        }
    }

    setChannelManager(channelManager) {
        this.channelManager = channelManager;
    }

    async getChannelsForUser(username) {
        if (!this.channelManager) {
            return [];
        }
        return this.channelManager.getChannelsForUser(username);
    }

    buildM3UPlaylist(channels, username, clientIP) {
        let playlist = '#EXTM3U\n';
        
        channels.forEach(channel => {
            // 生成加密的频道链接
            const encryptedUrl = this.generateEncryptedChannelUrl(channel.url, username, channel.id, clientIP);
            
            playlist += `#EXTINF:-1 tvg-id="${channel.id}" tvg-name="${channel.name}" tvg-logo="${channel.logo}" group-title="${channel.category}",${channel.name}\n`;
            playlist += `${encryptedUrl}\n`;
        });
        
        return playlist;
    }

    buildM3UPlusPlaylist(channels, username, clientIP) {
        const serverUrl = this.getServerUrl();
        let playlist = `#EXTM3U x-tvg-url="${serverUrl}/xmltv.php"\n`;
        
        channels.forEach(channel => {
            // 生成加密的频道链接
            const encryptedUrl = this.generateEncryptedChannelUrl(channel.url, username, channel.id, clientIP);
            
            const extinf = `#EXTINF:-1`;
            const attributes = [
                `tvg-id="${channel.tvgId || channel.id}"`,
                `tvg-name="${channel.tvgName || channel.name}"`,
                `tvg-logo="${channel.logo || ''}"`,
                `group-title="${channel.category || 'General'}"`,
                `tvg-chno="${channel.number || channel.id}"`,
                `tvg-shift="${channel.timeshift || 0}"`
            ];
            
            playlist += `${extinf} ${attributes.join(' ')},${channel.name}\n`;
            playlist += `${encryptedUrl}\n`;
        });
        
        return playlist;
    }

    // 生成加密的频道链接 - 修改参数，不传递clientIP到加密函数
    generateEncryptedChannelUrl(originalUrl, username, channelId, clientIP) {
        const serverUrl = this.getServerUrl();
        const encryptedToken = this.encryptChannelUrl(originalUrl, username, channelId, 120);
        const encryptedUrl = `${serverUrl}/live/encrypted/${encryptedToken}?username=${username}`;
        return encryptedUrl;
    }

    generateEncryptionKey() {
        // 生成一个固定的32字节密钥
        if (!this.encryptionKeyBuffer) {
            const keySource = this.config.security?.encryptionKey || 'xtream-proxy-default-key';
            this.encryptionKeyBuffer = crypto.scryptSync(keySource, 'salt', 32);
        }
        return this.encryptionKeyBuffer;
    }

    // 修改加密函数，移除clientIP参数
    encryptChannelUrl(originalUrl, username, channelId, expiryMinutes = 120) {
        const payload = {
            url: originalUrl,
            username: username,
            channelId: channelId,
            expiresAt: Date.now() + (expiryMinutes * 60 * 1000),
            tokenId: uuidv4()
        };
        
        try {
            // 使用现代的crypto API
            const algorithm = 'aes-256-cbc';
            const key = this.generateEncryptionKey();
            const iv = crypto.randomBytes(16);
            
            const cipher = crypto.createCipheriv(algorithm, key, iv);
            
            let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'hex');
            encrypted += cipher.final('hex');
            
            // 将IV和加密数据组合
            const result = iv.toString('hex') + ':' + encrypted;
            
            return Buffer.from(result).toString('base64url');
        } catch (error) {
            console.error(`❌ ${username} 加密失败:`, error.message);
            this.logger.error('Encryption error:', error);
            // 降级到简单编码
            return Buffer.from(JSON.stringify(payload)).toString('base64url');
        }
    }

    decryptChannelToken(encryptedToken, username, clientIP) {
        try {
            // 解码base64url
            const combined = Buffer.from(encryptedToken, 'base64url').toString();
            
            // 检查是否包含IV（加密格式）
            if (combined.includes(':')) {
                const parts = combined.split(':');
                if (parts.length === 2) {
                    const iv = Buffer.from(parts[0], 'hex');
                    const encrypted = parts[1];
                    
                    const algorithm = 'aes-256-cbc';
                    const key = this.generateEncryptionKey();
                    const decipher = crypto.createDecipheriv(algorithm, key, iv);
                    
                    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
                    decrypted += decipher.final('utf8');
                    
                    const payload = JSON.parse(decrypted);
                    return this.validateTokenPayload(payload, username, clientIP);
                }
            }
            
            // 降级处理：直接解析JSON（用于向后兼容）
            const payload = JSON.parse(combined);
            return this.validateTokenPayload(payload, username, clientIP);
            
        } catch (error) {
            // 优化错误处理 - 避免显示堆栈跟踪
            const errorMessage = error.message || 'Unknown error';
            
            // 只记录错误消息，不显示完整堆栈跟踪
            this.logger.error(`Token decryption failed for user ${username}: ${errorMessage}`);
            
            // 保持原始错误信息，移除IP mismatch错误
            if (errorMessage === 'User not found' || 
                errorMessage === 'User disabled' || 
                errorMessage === 'Token expired' || 
                errorMessage === 'Invalid username') {
                throw error;
            }
            
            throw new Error('Invalid token');
        }
    }

    validateTokenPayload(payload, username, clientIP) {
        // 验证token过期时间
        if (payload.expiresAt <= Date.now()) {
            throw new Error('Token expired');
        }
        
        // 验证用户名匹配
        if (payload.username !== username) {
            throw new Error('Invalid username');
        }
        
        // 移除IP验证 - 只保留注释
        // if (payload.clientIP !== clientIP) {
        //     throw new Error('IP mismatch');
        // }
        
        // 🔒 关键安全检查：验证用户是否仍然存在且启用
        const user = this.users[username];
        if (!user) {
            throw new Error('User not found');
        }
        
        if (!user.enabled) {
            throw new Error('User disabled');
        }
        
        return payload;
    }

    // 检查用户是否超过刷新限制
    getUserRefreshStatus(username) {
        const hourlyLimit = this.userHourlyLimits.get(username);
        const dailyLimit = this.userDailyLimits.get(username);
        
        return {
            hourly: {
                count: hourlyLimit?.count || 0,
                max: 10,
                resetTime: hourlyLimit?.resetTime || 0
            },
            daily: {
                count: dailyLimit?.count || 0,
                max: 2,
                resetTime: dailyLimit?.resetTime || 0
            }
        };
    }

    // 撤销用户所有访问权限
    revokeUserAccess(username, reason = 'Manual revoke') {
        console.log(`🚫 撤销用户: ${username}`);
        
        // 删除用户
        const userDeleted = this.deleteUser(username);
        
        // 清理相关限制和流
        this.userHourlyLimits.delete(username);
        this.userDailyLimits.delete(username);
        
        // 清理活跃流
        let activeStreamsCleared = 0;
        for (const [streamId, stream] of this.activeStreams.entries()) {
            if (stream.username === username) {
                this.activeStreams.delete(streamId);
                activeStreamsCleared++;
            }
        }
        
        // 清理流连接
        let connectionKeysCleared = 0;
        for (const [streamKey, connections] of this.streamConnections.entries()) {
            if (streamKey.startsWith(`${username}:`)) {
                this.streamConnections.delete(streamKey);
                connectionKeysCleared++;
            }
        }
        
        // 清理Telegram用户映射
        if (this.telegramUsers.has(username)) {
            this.telegramUsers.delete(username);
        }
        
        this.saveUserLimits();
        console.log(`✅ ${username} 访问权限已完全撤销`);
        this.logger.info(`User ${username} access revoked: ${reason}`);
    }

    // 重置用户的每小时播放列表刷新限制（用于生成新链接时）
    resetUserHourlyLimit(username) {
        this.userHourlyLimits.delete(username);
        this.saveUserLimits();
        console.log(`🔄 ${username} 每小时限制已重置`);
        this.logger.info(`User ${username} hourly limit reset`);
    }

    // 调试：显示用户的活跃流状态
    showUserActiveStreams(username) {
        const userStreams = [];
        const userDevices = new Set();
        
        for (const [streamId, stream] of this.activeStreams.entries()) {
            if (stream.username === username) {
                userStreams.push({
                    streamId: streamId.substring(0, 8),
                    channelId: stream.channelId,
                    clientIP: stream.clientIP,
                    age: Math.floor((Date.now() - stream.startTime) / 1000),
                    inactive: Math.floor((Date.now() - stream.lastActivity) / 1000)
                });
                userDevices.add(stream.clientIP);
            }
        }
        
        console.log(`📊 ${username} 活跃流状态: ${userDevices.size} 设备, ${userStreams.length} 流`);
        userStreams.forEach(stream => {
            console.log(`   - ${stream.streamId}: ${stream.channelId} from ${stream.clientIP} (存活${stream.age}s, 不活跃${stream.inactive}s)`);
        });
        
        return { devices: userDevices.size, streams: userStreams.length };
    }

    cleanup() {
        this.cleanupExpiredTokens();
        this.cleanupExpiredPlaylists();
        this.cleanupInactiveStreams();
    }

    cleanupExpiredTokens() {
        const now = Date.now();
        let cleanedCount = 0;
        
        for (const [token, data] of this.redirectTokens.entries()) {
            if (data.expiresAt <= now) {
                this.redirectTokens.delete(token);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            this.logger.debug(`Cleaned up ${cleanedCount} expired tokens`);
        }
    }

    cleanupExpiredPlaylists() {
        const now = Date.now();
        let cleanedCount = 0;
        
        for (const [id, playlist] of this.persistentPlaylists.entries()) {
            if (playlist.expiresAt && playlist.expiresAt <= now) {
                this.persistentPlaylists.delete(id);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            this.logger.debug(`Cleaned up ${cleanedCount} expired playlists`);
            this.savePersistentData();
        }
    }

    // 清理不活跃的流
    cleanupInactiveStreams() {
        const now = Date.now();
        const inactiveThreshold = 5 * 60 * 1000; // 5分钟不活跃
        let cleanedCount = 0;
        
        for (const [streamId, stream] of this.activeStreams.entries()) {
            if (now - stream.lastActivity > inactiveThreshold) {
                this.removeStreamConnection(stream.username, stream.channelId, stream.clientIP);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            this.logger.debug(`Cleaned up ${cleanedCount} inactive streams`);
        }
    }

    getUsers() {
        return this.users;
    }

    getUserCount() {
        return Object.keys(this.users).length;
    }

    getActiveUsers() {
        return Object.entries(this.users)
            .filter(([_, user]) => user.enabled)
            .map(([username, user]) => ({ username, ...user }));
    }

    async gracefulShutdown() {
        this.saveUsers();
        this.savePersistentData();
        this.saveUserLimits();
        this.logger.info('✅ UserManager shutdown completed');
    }

    // 新增：获取服务器URL的方法
    getServerUrl() {
        // 优先使用配置中的外部URL，否则使用localhost
        if (this.config.server.externalUrl) {
            return this.config.server.externalUrl;
        }
        
        // 如果配置了host且不是0.0.0.0，使用配置的host
        const host = this.config.server.host === '0.0.0.0' ? 'localhost' : this.config.server.host;
        return `http://${host}:${this.config.server.port}`;
    }
}

module.exports = UserManager; 