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

async function clearWebhook() {
    const config = loadConfig();
    
    if (!config.telegram?.botToken) {
        console.error('❌ 配置中未找到Telegram机器人令牌');
        process.exit(1);
    }
    
    console.log('🔧 清理Telegram机器人Webhook配置...');
    
    try {
        // 创建机器人实例但不启动轮询
        const bot = new TelegramBot(config.telegram.botToken, { polling: false });
        
        // 获取当前webhook信息
        console.log('📡 检查当前Webhook状态...');
        const webhookInfo = await bot.getWebHookInfo();
        
        console.log('当前Webhook信息:');
        console.log('   - URL:', webhookInfo.url || '未设置');
        console.log('   - 待处理更新:', webhookInfo.pending_update_count);
        console.log('   - 最后错误日期:', webhookInfo.last_error_date ? new Date(webhookInfo.last_error_date * 1000) : '无');
        console.log('   - 最后错误消息:', webhookInfo.last_error_message || '无');
        
        if (!webhookInfo.url) {
            console.log('✅ 没有设置Webhook，无需清理');
            return;
        }
        
        // 删除webhook
        console.log('\n🗑️  删除Webhook配置...');
        const result = await bot.deleteWebHook({ drop_pending_updates: true });
        
        if (result) {
            console.log('✅ Webhook已成功删除');
            console.log('📋 待处理的更新也已清理');
        } else {
            console.log('❌ 删除Webhook失败');
        }
        
        // 再次检查状态
        console.log('\n🔍 验证清理结果...');
        const newWebhookInfo = await bot.getWebHookInfo();
        
        if (!newWebhookInfo.url) {
            console.log('✅ 确认: Webhook已完全清理');
            console.log('💡 现在可以安全地使用轮询模式');
        } else {
            console.log('⚠️  警告: Webhook仍然存在');
            console.log('   - URL:', newWebhookInfo.url);
        }
        
    } catch (error) {
        console.error('❌ 清理Webhook失败:', error.message);
        
        if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 401) {
            console.log('💡 机器人令牌无效，请检查配置文件中的botToken');
        } else if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
            console.log('💡 检测到机器人冲突，请先停止其他使用此令牌的程序');
        }
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    clearWebhook().catch(console.error);
}

module.exports = { clearWebhook }; 