const fs = require('fs');
const path = require('path');

class ConfigManager {
    constructor(configPath = null) {
        this.configPath = configPath || path.join(__dirname, '../../config.json');
        this.config = null;
        this.loadConfig();
    }
    
    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const configData = fs.readFileSync(this.configPath, 'utf8');
                this.config = JSON.parse(configData);
                console.log('✅ Configuration loaded successfully');
            } else {
                console.warn('⚠️  Config file not found, using default configuration');
                this.config = this.getDefaultConfig();
            }
        } catch (error) {
            console.error('❌ Error loading config:', error);
            this.config = this.getDefaultConfig();
        }
    }
    
    getDefaultConfig() {
        return {
            server: {
                port: 8080,
                host: '0.0.0.0'
            },
            originalServer: {
                url: 'http://example.com',
                m3uPath: '/tv.m3u',
                timeout: 10000,
                autoRefreshInterval: 7200000,
                enableAutoRefresh: true
            },
            telegram: {
                botToken: '',
                groupId: '',
                adminUserId: '',
                adminUserIds: [],
                tokenExpiry: 600000,
                maxTokensPerUser: 2,
                tokenGenerationPeriod: 86400000
            },
            users: {},
            security: {
                connectionTimeout: 60000,
                cleanupInterval: 20000,
                enableLogging: false,
                allowedIPs: [],
                blockedIPs: [],
                enableIPBinding: false,
                redirectTokenExpiry: 7200000,
                maxTokenUsage: 3
            },
            features: {
                enableAdmin: true,
                enableStatus: true,
                enableEPG: true,
                cacheChannels: true,
                channelRefreshInterval: 3600000,
                enableTelegramBot: false,
                filterChannels: {
                    enabled: false,
                    blacklistKeywords: [],
                    whitelistKeywords: []
                }
            },
            playlist: {
                refreshLimitPeriod: 18000000,
                maxRefreshesBeforeExpiry: 6,
                maxSimultaneousPlaylists: 3,
                defaultLinkExpiry: 31536000000,
                enablePersistentStorage: true,
                persistentStorageCleanupInterval: 86400000,
                enablePermanentUsers: false
            }
        };
    }
    
    getConfig() {
        return this.config;
    }
    
    updateConfig(updates) {
        this.config = { ...this.config, ...updates };
        this.saveConfig();
    }
    
    saveConfig() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
            console.log('✅ Configuration saved successfully');
        } catch (error) {
            console.error('❌ Error saving config:', error);
        }
    }
    
    get(key, defaultValue = null) {
        const keys = key.split('.');
        let value = this.config;
        
        for (const k of keys) {
            if (value && typeof value === 'object' && k in value) {
                value = value[k];
            } else {
                return defaultValue;
            }
        }
        
        return value;
    }
    
    set(key, value) {
        const keys = key.split('.');
        const lastKey = keys.pop();
        let target = this.config;
        
        for (const k of keys) {
            if (!target[k] || typeof target[k] !== 'object') {
                target[k] = {};
            }
            target = target[k];
        }
        
        target[lastKey] = value;
        this.saveConfig();
    }
}

module.exports = ConfigManager; 