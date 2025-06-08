const fs = require('fs');
const path = require('path');

class SecurityManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        
        this.activeConnections = new Map();
        this.blockedIPs = new Set(config.security?.blockedIPs || []);
        this.allowedIPs = new Set(config.security?.allowedIPs || []);
        this.rateLimits = new Map();
        
        // 数据文件路径
        this.dataDir = path.join(__dirname, '../../data');
        this.securityFile = path.join(this.dataDir, 'security.json');
        
        this.ensureDataDirectory();
        this.loadSecurityData();
    }
    
    ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }
    
    loadSecurityData() {
        try {
            if (fs.existsSync(this.securityFile)) {
                const data = JSON.parse(fs.readFileSync(this.securityFile, 'utf8'));
                
                if (data.blockedIPs) {
                    this.blockedIPs = new Set(data.blockedIPs);
                }
                
                if (data.allowedIPs) {
                    this.allowedIPs = new Set(data.allowedIPs);
                }
                
                this.logger.info(`Loaded security data: ${this.blockedIPs.size} blocked IPs, ${this.allowedIPs.size} allowed IPs`);
            }
        } catch (error) {
            this.logger.error('Error loading security data:', error);
        }
    }
    
    saveSecurityData() {
        try {
            const data = {
                blockedIPs: Array.from(this.blockedIPs),
                allowedIPs: Array.from(this.allowedIPs),
                lastUpdated: Date.now()
            };
            
            fs.writeFileSync(this.securityFile, JSON.stringify(data, null, 2));
        } catch (error) {
            this.logger.error('Error saving security data:', error);
        }
    }
    
    validateRequest(req, res, next) {
        const clientIP = this.getClientIP(req);
        
        // 检查IP是否被阻止
        if (this.isIPBlocked(clientIP)) {
            this.logger.warn(`Blocked request from IP: ${clientIP}`);
            return res.status(403).json({ error: 'Access denied' });
        }
        
        // 检查IP白名单（如果启用）
        if (this.allowedIPs.size > 0 && !this.isIPAllowed(clientIP)) {
            this.logger.warn(`Unauthorized IP access attempt: ${clientIP}`);
            return res.status(403).json({ error: 'IP not authorized' });
        }
        
        // 速率限制检查
        if (!this.checkRateLimit(clientIP)) {
            this.logger.warn(`Rate limit exceeded for IP: ${clientIP}`);
            return res.status(429).json({ error: 'Too many requests' });
        }
        
        // 记录连接
        this.recordConnection(clientIP, req);
        
        next();
    }
    
    getClientIP(req) {
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.headers['x-real-ip'] ||
               req.connection?.remoteAddress ||
               req.socket?.remoteAddress ||
               req.ip ||
               'unknown';
    }
    
    isIPBlocked(ip) {
        return this.blockedIPs.has(ip);
    }
    
    isIPAllowed(ip) {
        return this.allowedIPs.size === 0 || this.allowedIPs.has(ip);
    }
    
    blockIP(ip, reason = 'Manual block') {
        this.blockedIPs.add(ip);
        this.saveSecurityData();
        this.logger.info(`IP ${ip} blocked: ${reason}`);
    }
    
    unblockIP(ip) {
        const removed = this.blockedIPs.delete(ip);
        if (removed) {
            this.saveSecurityData();
            this.logger.info(`IP ${ip} unblocked`);
        }
        return removed;
    }
    
    allowIP(ip) {
        this.allowedIPs.add(ip);
        this.saveSecurityData();
        this.logger.info(`IP ${ip} added to whitelist`);
    }
    
    removeAllowedIP(ip) {
        const removed = this.allowedIPs.delete(ip);
        if (removed) {
            this.saveSecurityData();
            this.logger.info(`IP ${ip} removed from whitelist`);
        }
        return removed;
    }
    
    checkRateLimit(ip) {
        const now = Date.now();
        const windowMs = 60000; // 1分钟窗口
        const maxRequests = 100; // 每分钟最大请求数
        
        if (!this.rateLimits.has(ip)) {
            this.rateLimits.set(ip, {
                count: 1,
                windowStart: now
            });
            return true;
        }
        
        const limit = this.rateLimits.get(ip);
        
        // 重置窗口
        if (now - limit.windowStart > windowMs) {
            limit.count = 1;
            limit.windowStart = now;
            return true;
        }
        
        // 检查限制
        if (limit.count >= maxRequests) {
            return false;
        }
        
        limit.count++;
        return true;
    }
    
    recordConnection(ip, req) {
        const now = Date.now();
        const connectionKey = `${ip}-${req.url}`;
        
        this.activeConnections.set(connectionKey, {
            ip: ip,
            url: req.url,
            userAgent: req.headers['user-agent'],
            timestamp: now
        });
    }
    
    cleanup() {
        this.cleanupOldConnections();
        this.cleanupRateLimits();
    }
    
    cleanupOldConnections() {
        const now = Date.now();
        const timeout = this.config.security?.connectionTimeout || 300000; // 5分钟
        let cleanedCount = 0;
        
        for (const [key, connection] of this.activeConnections.entries()) {
            if (now - connection.timestamp > timeout) {
                this.activeConnections.delete(key);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            this.logger.debug(`Cleaned up ${cleanedCount} old connections`);
        }
    }
    
    cleanupRateLimits() {
        const now = Date.now();
        const windowMs = 60000;
        let cleanedCount = 0;
        
        for (const [ip, limit] of this.rateLimits.entries()) {
            if (now - limit.windowStart > windowMs) {
                this.rateLimits.delete(ip);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            this.logger.debug(`Cleaned up ${cleanedCount} old rate limits`);
        }
    }
    
    getActiveConnections() {
        return Array.from(this.activeConnections.values());
    }
    
    getConnectionCount() {
        return this.activeConnections.size;
    }
    
    getBlockedIPs() {
        return Array.from(this.blockedIPs);
    }
    
    getAllowedIPs() {
        return Array.from(this.allowedIPs);
    }
    
    getSecurityStats() {
        return {
            activeConnections: this.getConnectionCount(),
            blockedIPs: this.blockedIPs.size,
            allowedIPs: this.allowedIPs.size,
            rateLimitEntries: this.rateLimits.size
        };
    }
    
    validateToken(token, requirements = {}) {
        try {
            // 基本token验证逻辑
            if (!token || typeof token !== 'string') {
                return false;
            }
            
            // 检查token格式
            if (token.length < 8) {
                return false;
            }
            
            // 可以添加更多的token验证逻辑
            return true;
        } catch (error) {
            this.logger.error('Token validation error:', error);
            return false;
        }
    }
    
    generateSecureToken(length = 32) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let token = '';
        
        for (let i = 0; i < length; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        
        return token;
    }
    
    // 检测可疑活动
    detectSuspiciousActivity(ip, req) {
        const patterns = [
            /\.\./,  // 路径遍历
            /<script/i,  // XSS尝试
            /union.*select/i,  // SQL注入尝试
            /javascript:/i  // JavaScript注入
        ];
        
        const url = req.url || '';
        const userAgent = req.headers['user-agent'] || '';
        
        for (const pattern of patterns) {
            if (pattern.test(url) || pattern.test(userAgent)) {
                this.logger.warn(`Suspicious activity detected from ${ip}: ${url}`);
                return true;
            }
        }
        
        return false;
    }
    
    async gracefulShutdown() {
        this.saveSecurityData();
        this.logger.info('✅ SecurityManager shutdown completed');
    }
}

module.exports = SecurityManager; 