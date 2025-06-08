const fs = require('fs');
const path = require('path');
const axios = require('axios');

class ChannelManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        
        this.channels = [];
        this.categories = [];
        this.lastRefresh = 0;
        
        // 数据文件路径
        this.dataDir = path.join(__dirname, '../../data');
        this.channelsFile = path.join(this.dataDir, 'channels.json');
        
        this.ensureDataDirectory();
    }
    
    ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }
    
    async initialize() {
        await this.loadChannels();
        this.logger.info('✅ ChannelManager initialized');
    }
    
    async loadChannels() {
        try {
            // 检查是否有有效的URL配置
            const hasValidUrl = this.config.originalServer?.url && 
                               this.config.originalServer.url !== 'http://example.com' &&
                               this.config.originalServer.url !== '';
            
            if (hasValidUrl) {
                // 如果有有效URL，优先从服务器刷新
                await this.refreshChannels();
                return;
            }
            
            // 如果没有有效URL，尝试从缓存加载
            if (this.config.features.cacheChannels && fs.existsSync(this.channelsFile)) {
                const cacheData = JSON.parse(fs.readFileSync(this.channelsFile, 'utf8'));
                const cacheAge = Date.now() - cacheData.timestamp;
                const maxCacheAge = this.config.features.channelRefreshInterval || 3600000;
                
                if (cacheAge < maxCacheAge) {
                    this.channels = cacheData.channels || [];
                    this.categories = cacheData.categories || [];
                    this.lastRefresh = cacheData.timestamp;
                    this.logger.info(`Loaded ${this.channels.length} channels from cache`);
                    return;
                }
            }
            
            // 如果没有缓存或缓存过期，创建示例频道
            this.createSampleChannels();
            
        } catch (error) {
            this.logger.error('Error loading channels:', error);
            this.createSampleChannels();
        }
    }
    
    async refreshChannels() {
        try {
            this.logger.info('Refreshing channels from original server...');
            
            const response = await axios.get(
                `${this.config.originalServer.url}${this.config.originalServer.m3uPath}`,
                {
                    timeout: this.config.originalServer.timeout || 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }
            );
            
            const channelData = this.parseM3UContent(response.data);
            this.channels = channelData.channels;
            this.categories = channelData.categories;
            this.lastRefresh = Date.now();
            
            // 应用频道过滤
            if (this.config.features.filterChannels?.enabled) {
                this.applyChannelFilters();
            }
            
            // 缓存频道数据
            if (this.config.features.cacheChannels) {
                this.saveChannelsToCache();
            }
            
            this.logger.success(`Successfully loaded ${this.channels.length} channels from ${this.categories.length} categories`);
            
        } catch (error) {
            this.logger.error('Error refreshing channels:', error);
            
            // 如果没有缓存的频道，创建示例频道
            if (this.channels.length === 0) {
                this.createSampleChannels();
            }
        }
    }
    
    parseM3UContent(content) {
        const lines = content.split('\n');
        const channels = [];
        const categories = new Set();
        
        let currentChannel = null;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                currentChannel = this.parseExtinfLine(line);
                if (currentChannel.category) {
                    categories.add(currentChannel.category);
                }
            } else if (line && !line.startsWith('#') && currentChannel) {
                currentChannel.url = line;
                currentChannel.id = channels.length + 1;
                channels.push(currentChannel);
                currentChannel = null;
            }
        }
        
        return {
            channels,
            categories: Array.from(categories).sort()
        };
    }
    
    parseExtinfLine(line) {
        const channel = {
            name: '',
            logo: '',
            category: '',
            tvgId: '',
            tvgName: ''
        };
        
        // 提取频道名称
        const nameMatch = line.match(/,(.+)$/);
        if (nameMatch) {
            channel.name = nameMatch[1].trim();
        }
        
        // 提取属性
        const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
        if (tvgIdMatch) {
            channel.tvgId = tvgIdMatch[1];
        }
        
        const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);
        if (tvgNameMatch) {
            channel.tvgName = tvgNameMatch[1];
        }
        
        const logoMatch = line.match(/tvg-logo="([^"]*)"/);
        if (logoMatch) {
            channel.logo = logoMatch[1];
        }
        
        const categoryMatch = line.match(/group-title="([^"]*)"/);
        if (categoryMatch) {
            channel.category = categoryMatch[1];
        }
        
        return channel;
    }
    
    applyChannelFilters() {
        const filters = this.config.features.filterChannels;
        let filteredChannels = [...this.channels];
        
        // 应用黑名单过滤
        if (filters.blacklistKeywords?.length > 0) {
            filteredChannels = filteredChannels.filter(channel => {
                return !filters.blacklistKeywords.some(keyword => 
                    channel.name.toLowerCase().includes(keyword.toLowerCase())
                );
            });
        }
        
        // 应用白名单过滤
        if (filters.whitelistKeywords?.length > 0) {
            filteredChannels = filteredChannels.filter(channel => {
                return filters.whitelistKeywords.some(keyword => 
                    channel.name.toLowerCase().includes(keyword.toLowerCase())
                );
            });
        }
        
        const originalCount = this.channels.length;
        this.channels = filteredChannels;
        
        this.logger.info(`Channel filtering: ${originalCount} -> ${this.channels.length} channels`);
    }
    
    saveChannelsToCache() {
        try {
            const cacheData = {
                channels: this.channels,
                categories: this.categories,
                timestamp: this.lastRefresh
            };
            
            fs.writeFileSync(this.channelsFile, JSON.stringify(cacheData, null, 2));
            this.logger.debug('Channels cached successfully');
        } catch (error) {
            this.logger.error('Error saving channels to cache:', error);
        }
    }
    
    createSampleChannels() {
        this.logger.warn('Creating sample channels as fallback');
        
        this.channels = [
            {
                id: 1,
                name: 'Sample Channel 1',
                category: 'General',
                logo: '',
                tvgId: 'sample1',
                tvgName: 'Sample Channel 1',
                url: 'http://example.com/stream1.m3u8'
            },
            {
                id: 2,
                name: 'Sample Channel 2',
                category: 'General',
                logo: '',
                tvgId: 'sample2',
                tvgName: 'Sample Channel 2',
                url: 'http://example.com/stream2.m3u8'
            }
        ];
        
        this.categories = ['General'];
        this.lastRefresh = Date.now();
    }
    
    getChannels(categoryFilter = null) {
        if (categoryFilter) {
            return this.channels.filter(channel => channel.category === categoryFilter);
        }
        return this.channels;
    }
    
    getChannelById(id) {
        return this.channels.find(channel => channel.id === parseInt(id));
    }
    
    getCategories() {
        return this.categories;
    }
    
    getChannelCount() {
        return this.channels.length;
    }
    
    getCategoryCount() {
        return this.categories.length;
    }
    
    async generateXMLTV() {
        let xmltv = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xmltv += '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
        xmltv += '<tv generator-info-name="Xtream Codes Proxy">\n';
        
        // 添加频道信息
        this.channels.forEach(channel => {
            xmltv += `  <channel id="${channel.tvgId || channel.id}">\n`;
            xmltv += `    <display-name>${this.escapeXml(channel.name)}</display-name>\n`;
            if (channel.logo) {
                xmltv += `    <icon src="${this.escapeXml(channel.logo)}" />\n`;
            }
            xmltv += '  </channel>\n';
        });
        
        xmltv += '</tv>\n';
        return xmltv;
    }
    
    escapeXml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
    
    getChannelsForUser(username) {
        // 这里可以根据用户权限返回不同的频道列表
        // 目前返回所有频道
        return this.channels;
    }
    
    updateConfig(newConfig) {
        this.config = newConfig;
        this.logger.info('ChannelManager configuration updated');
    }

    getServerInfo() {
        return {
            url: this.config.originalServer.url,
            lastRefresh: this.lastRefresh,
            channelCount: this.channels.length,
            categoryCount: this.categories.length,
            autoRefresh: this.config.originalServer.enableAutoRefresh
        };
    }
    
    async gracefulShutdown() {
        if (this.config.features.cacheChannels) {
            this.saveChannelsToCache();
        }
        this.logger.info('✅ ChannelManager shutdown completed');
    }
}

module.exports = ChannelManager; 