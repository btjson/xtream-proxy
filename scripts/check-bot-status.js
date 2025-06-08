#!/usr/bin/env node

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// 读取配置
function loadConfig() {
    const configPath = path.join(__dirname, '../config.json');
    if (!fs.existsSync(configPath)) {
        console.error('❌ 配置文件不存在:', configPath);
        process.exit(1);
    }
    
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        console.error('❌ 读取配置文件失败:', error.message);
        process.exit(1);
    }
}

async function checkBotStatus() {
    const config = loadConfig();
    
    if (!config.telegram?.botToken) {
        console.error('❌ 配置中未找到Telegram机器人令牌');
        process.exit(1);
    }
    
    console.log('🔍 检查Telegram机器人状态...');
    console.log('📋 机器人令牌:', config.telegram.botToken.substring(0, 10) + '...');
    
    try {
        // 创建机器人实例但不启动轮询
        const bot = new TelegramBot(config.telegram.botToken, { polling: false });
        
        // 获取机器人信息
        const botInfo = await bot.getMe();
        console.log('✅ 机器人信息:');
        console.log('   - 用户名:', botInfo.username);
        console.log('   - 名称:', botInfo.first_name);
        console.log('   - ID:', botInfo.id);
        
        // 尝试获取webhook信息
        try {
            const webhookInfo = await bot.getWebHookInfo();
            console.log('📡 Webhook状态:');
            console.log('   - URL:', webhookInfo.url || '未设置');
            console.log('   - 待处理更新:', webhookInfo.pending_update_count);
            
            if (webhookInfo.url) {
                console.log('⚠️  检测到Webhook配置，这可能与轮询模式冲突');
                console.log('💡 建议删除Webhook: 运行 node scripts/clear-webhook.js');
            }
        } catch (webhookError) {
            console.log('⚠️  无法获取Webhook信息:', webhookError.message);
        }
        
        // 测试轮询
        console.log('\n🔄 测试轮询模式...');
        const testBot = new TelegramBot(config.telegram.botToken, { 
            polling: {
                interval: 1000,
                autoStart: false,
                params: { timeout: 5 }
            }
        });
        
        try {
            await testBot.startPolling();
            console.log('✅ 轮询模式测试成功');
            await testBot.stopPolling();
            console.log('✅ 轮询已停止');
        } catch (pollingError) {
            if (pollingError.code === 'ETELEGRAM' && pollingError.response?.body?.error_code === 409) {
                console.log('❌ 检测到机器人冲突 (错误码: 409)');
                console.log('📋 错误详情:', pollingError.response.body.description);
                console.log('\n🔧 解决方案:');
                console.log('1. 停止所有其他使用此机器人令牌的程序');
                console.log('2. 等待30-60秒让Telegram服务器清理连接');
                console.log('3. 重新启动此程序');
                console.log('4. 如果问题持续，运行: node scripts/clear-webhook.js');
            } else {
                console.log('❌ 轮询测试失败:', pollingError.message);
            }
        }
        
    } catch (error) {
        console.error('❌ 检查机器人状态失败:', error.message);
        
        if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 401) {
            console.log('💡 机器人令牌无效，请检查配置文件中的botToken');
        }
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    checkBotStatus().catch(console.error);
}

module.exports = { checkBotStatus }; 