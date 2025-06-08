const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class TokenManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        
        this.tokens = new Map();
        this.tokenLimits = new Map();
        
        // 数据文件路径
        this.dataDir = path.join(__dirname, '../../../data');
        this.tokensFile = path.join(this.dataDir, 'telegram-tokens.json');
        this.limitsFile = path.join(this.dataDir, 'telegram-limits.json');
        
        this.ensureDataDirectory();
        this.loadTokens();
    }
    
    ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }
    
    loadTokens() {
        try {
            // 加载tokens
            if (fs.existsSync(this.tokensFile)) {
                const tokensData = JSON.parse(fs.readFileSync(this.tokensFile, 'utf8'));
                const now = Date.now();
                
                for (const [token, data] of Object.entries(tokensData)) {
                    if (data.expiresAt > now && !data.used) {
                        this.tokens.set(token, data);
                    }
                }
                
                this.logger.info(`Loaded ${this.tokens.size} valid tokens`);
            }
            
            // 加载限制
            if (fs.existsSync(this.limitsFile)) {
                const limitsData = JSON.parse(fs.readFileSync(this.limitsFile, 'utf8'));
                const now = Date.now();
                
                for (const [userId, limitData] of Object.entries(limitsData)) {
                    if (limitData.resetTime > now) {
                        this.tokenLimits.set(parseInt(userId), limitData);
                    }
                }
                
                this.logger.info(`Loaded ${this.tokenLimits.size} token limits`);
            }
        } catch (error) {
            this.logger.error('Error loading tokens:', error);
        }
    }
    
    saveData() {
        try {
            // 保存tokens
            const tokensData = Object.fromEntries(this.tokens);
            fs.writeFileSync(this.tokensFile, JSON.stringify(tokensData, null, 2));
            
            // 保存限制
            const limitsData = Object.fromEntries(this.tokenLimits);
            fs.writeFileSync(this.limitsFile, JSON.stringify(limitsData, null, 2));
        } catch (error) {
            this.logger.error('Error saving token data:', error);
        }
    }
    
    generateToken() {
        return Math.random().toString(36).substring(2, 10).toUpperCase();
    }
    
    createToken(userId, username) {
        // 检查生成限制
        if (!this.canGenerateToken(userId)) {
            throw new Error('Token generation limit exceeded');
        }
        
        const token = this.generateToken();
        const tokenData = {
            userId: userId,
            username: username,
            token: token,
            createdAt: Date.now(),
            expiresAt: Date.now() + this.config.tokenExpiry,
            used: false
        };
        
        this.tokens.set(token, tokenData);
        this.incrementTokenCount(userId);
        this.saveData(); // 保存数据
        
        this.logger.info(`Token created for user ${username}: ${token}`);
        return tokenData;
    }
    
    verifyToken(token, userId) {
        const tokenData = this.tokens.get(token);
        
        if (!tokenData) {
            return null;
        }
        
        if (tokenData.used) {
            return null;
        }
        
        if (tokenData.expiresAt <= Date.now()) {
            this.tokens.delete(token);
            return null;
        }
        
        if (tokenData.userId !== userId) {
            return null;
        }
        
        // 标记为已使用
        tokenData.used = true;
        
        this.logger.info(`Token verified for user ${tokenData.username}: ${token}`);
        return tokenData;
    }
    
    canGenerateToken(userId) {
        const now = Date.now();
        const limit = this.tokenLimits.get(userId);
        const maxTokens = this.config.maxTokensPerUser || 2;
        const period = this.config.tokenGenerationPeriod || 86400000; // 24小时
        
        if (!limit) {
            return true;
        }
        
        // 检查是否需要重置计数器
        if (now - limit.firstGenerated > period) {
            this.tokenLimits.delete(userId);
            return true;
        }
        
        return limit.count < maxTokens;
    }
    
    incrementTokenCount(userId) {
        const now = Date.now();
        const limit = this.tokenLimits.get(userId);
        
        if (!limit) {
            this.tokenLimits.set(userId, {
                count: 1,
                firstGenerated: now,
                resetTime: now + this.config.tokenGenerationPeriod
            });
        } else {
            limit.count++;
        }
    }
    
    cleanupExpiredTokens() {
        const now = Date.now();
        let cleanedTokens = 0;
        let cleanedLimits = 0;
        
        // 清理过期tokens
        for (const [token, data] of this.tokens.entries()) {
            if (data.expiresAt <= now || data.used) {
                this.tokens.delete(token);
                cleanedTokens++;
            }
        }
        
        // 清理过期限制
        for (const [userId, limit] of this.tokenLimits.entries()) {
            if (limit.resetTime <= now) {
                this.tokenLimits.delete(userId);
                cleanedLimits++;
            }
        }
        
        if (cleanedTokens > 0 || cleanedLimits > 0) {
            this.logger.debug(`Cleaned up ${cleanedTokens} expired tokens and ${cleanedLimits} expired limits`);
        }
    }
    
    getActiveTokenCount() {
        return this.tokens.size;
    }
    
    getTokensForUser(userId) {
        return Array.from(this.tokens.values()).filter(token => 
            token.userId === userId && !token.used && token.expiresAt > Date.now()
        );
    }
    
    revokeTokensForUser(userId) {
        let revokedCount = 0;
        
        for (const [token, data] of this.tokens.entries()) {
            if (data.userId === userId) {
                this.tokens.delete(token);
                revokedCount++;
            }
        }
        
        this.tokenLimits.delete(userId);
        
        this.logger.info(`Revoked ${revokedCount} tokens for user ${userId}`);
        return revokedCount;
    }
    
    getStats() {
        return {
            activeTokens: this.tokens.size,
            activeLimits: this.tokenLimits.size
        };
    }
}

module.exports = TokenManager; 