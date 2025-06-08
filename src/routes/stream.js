const express = require('express');
const router = express.Router();
const axios = require('axios');

module.exports = (userManager, channelManager, securityManager) => {
    
    // 处理直播流请求
    router.get('/:username/:password/:streamId', async (req, res) => {
        try {
            const { username, password, streamId } = req.params;
            const clientIP = securityManager.getClientIP(req);
            
            console.log(`📺 Stream request: ${username} -> ${streamId} from ${clientIP}`);
            
            // 验证用户身份
            if (!userManager.authenticateUser(username, password)) {
                console.log(`❌ Authentication failed for user: ${username}`);
                return res.status(401).send('Unauthorized');
            }
            
            // 检查并发限制
            const streamSessionId = userManager.checkStreamConcurrency(username, streamId, clientIP);
            if (!streamSessionId) {
                console.log(`⚠️  Concurrent stream limit exceeded for ${username}:${streamId}`);
                return res.status(429).json({
                    error: 'Concurrent stream limit exceeded',
                    message: 'Maximum 3 devices can watch the same channel simultaneously'
                });
            }
            
            // 获取频道信息
            const channel = channelManager.getChannelById(streamId);
            if (!channel) {
                console.log(`❌ Channel not found: ${streamId}`);
                userManager.removeStreamConnection(username, streamId, clientIP);
                return res.status(404).send('Stream not found');
            }
            
            console.log(`🔄 Redirecting ${username} to: ${channel.url}`);
            
            // 302重定向到原始流URL
            res.redirect(302, channel.url);
            
        } catch (error) {
            console.error('❌ Stream proxy error:', error);
            res.status(500).send('Internal server error');
        }
    });
    
    // 处理加密的流重定向
    router.get('/encrypted/:token', async (req, res) => {
        try {
            const { token } = req.params;
            const { username } = req.query;
            const clientIP = securityManager.getClientIP(req);
            
            // 解密token并验证
            const payload = userManager.decryptChannelToken(token, username, clientIP);
            
            if (!payload) {
                return res.status(401).json({
                    error: 'Invalid or expired token',
                    message: 'Token has expired or is invalid'
                });
            }
            
            // 检查并发限制
            const streamSessionId = userManager.checkStreamConcurrency(username, payload.channelId, clientIP);
            if (!streamSessionId) {
                console.log(`⚠️  ${username} 并发限制超出`);
                return res.status(429).json({
                    error: 'Concurrent stream limit exceeded', 
                    message: 'Maximum 3 devices can watch the same channel simultaneously'
                });
            }
            
            // 记录流访问 - 简化日志
            console.log(`📺 ${username} -> 频道${payload.channelId}`);
            userManager.logger.info(`Stream access: ${username} -> ${payload.channelId} from ${clientIP}`);
            
            // 302重定向到真实的流URL
            res.redirect(302, payload.url);
            
        } catch (error) {
            // 根据错误类型提供不同的响应
            if (error.message === 'Token expired') {
                return res.status(401).json({
                    error: 'Token expired',
                    message: 'Please refresh your playlist to get new links'
                });
            }
            
            if (error.message === 'IP mismatch') {
                return res.status(403).json({
                    error: 'IP mismatch',
                    message: 'Stream can only be accessed from the same IP that requested the playlist'
                });
            }
            
            if (error.message === 'User not found') {
                return res.status(403).json({
                    error: 'User not found',
                    message: 'Your account has been removed. Please contact administrator.'
                });
            }
            
            if (error.message === 'User disabled') {
                return res.status(403).json({
                    error: 'Account disabled',
                    message: 'Your account has been disabled. Please contact administrator.'
                });
            }
            
            res.status(401).json({
                error: 'Invalid token',
                message: 'Token is invalid or malformed'
            });
        }
    });
    
    // 流心跳检测 - 更新活跃状态
    router.post('/heartbeat', async (req, res) => {
        try {
            const { username, channelId } = req.body;
            const clientIP = securityManager.getClientIP(req);
            
            console.log(`💓 Heartbeat: ${username}:${channelId} from ${clientIP}`);
            
            // 更新流活跃状态
            for (const [streamId, stream] of userManager.activeStreams.entries()) {
                if (stream.username === username && 
                    stream.channelId === channelId && 
                    stream.clientIP === clientIP) {
                    stream.lastActivity = Date.now();
                    break;
                }
            }
            
            res.json({ status: 'ok' });
            
        } catch (error) {
            console.error('❌ Heartbeat error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
    
    // 流结束通知
    router.post('/stream-end', async (req, res) => {
        try {
            const { username, channelId } = req.body;
            const clientIP = securityManager.getClientIP(req);
            
            console.log(`🛑 Stream ended: ${username}:${channelId} from ${clientIP}`);
            
            // 移除流连接
            userManager.removeStreamConnection(username, channelId, clientIP);
            
            res.json({ status: 'ok' });
            
        } catch (error) {
            console.error('❌ Stream end error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
    
    return router;
}; 