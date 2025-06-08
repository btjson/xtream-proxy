const express = require('express');
const router = express.Router();

module.exports = (userManager, channelManager, securityManager) => {
    
    // Player API路由处理
    router.get('/', async (req, res) => {
        try {
            const { action, username, password } = req.query;
            
            if (!action) {
                return res.status(400).json({ error: 'Action parameter required' });
            }
            
            // 验证用户身份
            if (!userManager.authenticateUser(username, password)) {
                return res.status(401).json({ error: 'Authentication failed' });
            }
            
            switch (action) {
                case 'get_live_categories':
                    await handleGetLiveCategories(req, res, channelManager);
                    break;
                    
                case 'get_live_streams':
                    await handleGetLiveStreams(req, res, channelManager);
                    break;
                    
                case 'get_series_categories':
                    await handleGetSeriesCategories(req, res);
                    break;
                    
                case 'get_vod_categories':
                    await handleGetVodCategories(req, res);
                    break;
                    
                case 'get_series':
                    await handleGetSeries(req, res);
                    break;
                    
                case 'get_vod_streams':
                    await handleGetVodStreams(req, res);
                    break;
                    
                case 'get_series_info':
                    await handleGetSeriesInfo(req, res);
                    break;
                    
                case 'get_vod_info':
                    await handleGetVodInfo(req, res);
                    break;
                    
                case 'get_short_epg':
                    await handleGetShortEPG(req, res);
                    break;
                    
                case 'get_simple_data_table':
                    await handleGetSimpleDataTable(req, res);
                    break;
                    
                default:
                    res.status(400).json({ error: 'Invalid action' });
            }
            
        } catch (error) {
            console.error('Player API error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
    
    return router;
};

// 获取直播分类
async function handleGetLiveCategories(req, res, channelManager) {
    try {
        const categories = channelManager.getCategories();
        const response = categories.map((category, index) => ({
            category_id: index + 1,
            category_name: category,
            parent_id: 0
        }));
        
        res.json(response);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get categories' });
    }
}

// 获取直播流
async function handleGetLiveStreams(req, res, channelManager) {
    try {
        const { category_id } = req.query;
        let channels = channelManager.getChannels();
        
        // 如果指定了分类，进行过滤
        if (category_id && category_id !== '0') {
            const categories = channelManager.getCategories();
            const categoryName = categories[parseInt(category_id) - 1];
            if (categoryName) {
                channels = channels.filter(channel => channel.category === categoryName);
            }
        }
        
        const response = channels.map(channel => ({
            num: channel.id,
            name: channel.name,
            stream_type: 'live',
            stream_id: channel.id,
            stream_icon: channel.logo || '',
            epg_channel_id: channel.tvgId || '',
            added: '1640995200',  // 示例时间戳
            category_id: req.query.category_id || '1',
            custom_sid: '',
            tv_archive: 0,
            direct_source: '',
            tv_archive_duration: 0
        }));
        
        res.json(response);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get live streams' });
    }
}

// 获取剧集分类（暂时返回空）
async function handleGetSeriesCategories(req, res) {
    res.json([]);
}

// 获取VOD分类（暂时返回空）
async function handleGetVodCategories(req, res) {
    res.json([]);
}

// 获取剧集（暂时返回空）
async function handleGetSeries(req, res) {
    res.json([]);
}

// 获取VOD流（暂时返回空）
async function handleGetVodStreams(req, res) {
    res.json([]);
}

// 获取剧集信息（暂时返回空）
async function handleGetSeriesInfo(req, res) {
    res.json({ info: {}, episodes: {} });
}

// 获取VOD信息（暂时返回空）
async function handleGetVodInfo(req, res) {
    res.json({ info: {}, movie_data: {} });
}

// 获取短EPG（暂时返回空）
async function handleGetShortEPG(req, res) {
    res.json({ epg_listings: [] });
}

// 获取简单数据表（暂时返回空）
async function handleGetSimpleDataTable(req, res) {
    res.json({ total: 0, data: [] });
} 