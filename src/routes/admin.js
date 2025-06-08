const express = require('express');
const router = express.Router();

module.exports = (userManager, channelManager, config) => {
    
    // 管理员面板首页
    router.get('/', (req, res) => {
        res.send(generateAdminPanelHTML(userManager, channelManager, config));
    });
    
    // 用户管理API
    router.get('/users', (req, res) => {
        const users = userManager.getUsers();
        const userList = Object.entries(users).map(([username, user]) => ({
            username,
            enabled: user.enabled,
            maxConnections: user.maxConnections,
            createdAt: user.createdAt,
            source: user.source || 'config'
        }));
        
        res.json({
            total: userList.length,
            users: userList
        });
    });
    
    // 创建用户
    router.post('/users', (req, res) => {
        const { username, password, maxConnections, enabled } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        
        try {
            const user = userManager.createUser(username, password, {
                maxConnections: parseInt(maxConnections) || 1,
                enabled: enabled !== false
            });
            
            res.json({
                success: true,
                message: `User ${username} created successfully`,
                user: user
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // 更新用户
    router.put('/users/:username', (req, res) => {
        const { username } = req.params;
        const updates = req.body;
        
        if (userManager.updateUser(username, updates)) {
            res.json({
                success: true,
                message: `User ${username} updated successfully`
            });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    });
    
    // 删除用户
    router.delete('/users/:username', (req, res) => {
        const { username } = req.params;
        
        if (userManager.deleteUser(username)) {
            res.json({
                success: true,
                message: `User ${username} deleted successfully`
            });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    });
    
    // 服务器状态
    router.get('/status', (req, res) => {
        const status = {
            server: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                version: require('../../package.json').version
            },
            users: {
                total: userManager.getUserCount(),
                active: userManager.getActiveUsers().length
            },
            channels: {
                total: channelManager.getChannelCount(),
                categories: channelManager.getCategoryCount(),
                lastRefresh: channelManager.lastRefresh
            }
        };
        
        res.json(status);
    });
    
    // 刷新频道列表
    router.post('/refresh-channels', async (req, res) => {
        try {
            await channelManager.refreshChannels();
            res.json({
                success: true,
                message: 'Channels refreshed successfully',
                count: channelManager.getChannelCount()
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    return router;
};

function generateAdminPanelHTML(userManager, channelManager, config) {
    return `
<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Xtream Codes Proxy - 管理面板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 30px; text-align: center; }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; }
        .header p { font-size: 1.1em; opacity: 0.9; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
        .stat-card h3 { color: #333; margin-bottom: 10px; font-size: 1.1em; }
        .stat-value { font-size: 2.5em; font-weight: bold; color: #667eea; }
        .stat-label { color: #666; margin-top: 5px; }
        .actions { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
        .actions h3 { margin-bottom: 20px; color: #333; }
        .btn { display: inline-block; padding: 12px 24px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; margin: 5px; border: none; cursor: pointer; font-size: 14px; }
        .btn:hover { background: #5a6fd8; }
        .btn-secondary { background: #6c757d; }
        .btn-secondary:hover { background: #5a6268; }
        .info-section { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); margin-top: 20px; }
        .info-section h3 { margin-bottom: 15px; color: #333; }
        .info-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
        .info-item:last-child { border-bottom: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎬 Xtream Codes Proxy</h1>
            <p>管理面板 - 服务器运行正常</p>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <h3>👥 用户统计</h3>
                <div class="stat-value">${userManager.getUserCount()}</div>
                <div class="stat-label">总用户数</div>
            </div>
            <div class="stat-card">
                <h3>📺 频道统计</h3>
                <div class="stat-value">${channelManager.getChannelCount()}</div>
                <div class="stat-label">总频道数</div>
            </div>
            <div class="stat-card">
                <h3>📁 分类统计</h3>
                <div class="stat-value">${channelManager.getCategoryCount()}</div>
                <div class="stat-label">分类数量</div>
            </div>
            <div class="stat-card">
                <h3>⚡ 服务器状态</h3>
                <div class="stat-value" style="font-size: 1.8em; color: #28a745;">在线</div>
                <div class="stat-label">运行时间: ${Math.floor(process.uptime() / 3600)}小时</div>
            </div>
        </div>
        
        <div class="actions">
            <h3>🛠️ 管理操作</h3>
            <button class="btn" onclick="refreshChannels()">🔄 刷新频道列表</button>
            <button class="btn" onclick="viewUsers()">👥 查看用户列表</button>
            <button class="btn btn-secondary" onclick="viewLogs()">📋 查看日志</button>
            <a href="/health" class="btn btn-secondary" target="_blank">💊 健康检查</a>
        </div>
        
        <div class="info-section">
            <h3>📊 系统信息</h3>
            <div class="info-item">
                <span>服务器地址:</span>
                <span>${config.server.host}:${config.server.port}</span>
            </div>
            <div class="info-item">
                <span>原始服务器:</span>
                <span>${config.originalServer.url}</span>
            </div>
            <div class="info-item">
                <span>Telegram机器人:</span>
                <span>${config.features.enableTelegramBot ? '✅ 已启用' : '❌ 未启用'}</span>
            </div>
            <div class="info-item">
                <span>频道缓存:</span>
                <span>${config.features.cacheChannels ? '✅ 已启用' : '❌ 未启用'}</span>
            </div>
        </div>
    </div>
    
    <script>
        async function refreshChannels() {
            const btn = event.target;
            btn.disabled = true;
            btn.textContent = '🔄 刷新中...';
            
            try {
                const response = await fetch('/admin/refresh-channels', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    alert('✅ 频道列表刷新成功！');
                    location.reload();
                } else {
                    alert('❌ 刷新失败: ' + result.error);
                }
            } catch (error) {
                alert('❌ 请求失败: ' + error.message);
            }
            
            btn.disabled = false;
            btn.textContent = '🔄 刷新频道列表';
        }
        
        async function viewUsers() {
            try {
                const response = await fetch('/admin/users');
                const result = await response.json();
                
                let userList = result.users.map(user => 
                    \`\${user.username} - \${user.enabled ? '启用' : '禁用'} (\${user.source})\`
                ).join('\\n');
                
                alert('用户列表:\\n\\n' + userList);
            } catch (error) {
                alert('获取用户列表失败: ' + error.message);
            }
        }
        
        function viewLogs() {
            alert('日志查看功能开发中...');
        }
    </script>
</body>
</html>
    `;
} 