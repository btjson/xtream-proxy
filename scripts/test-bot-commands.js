const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

function loadConfig() {
    const configPath = path.join(__dirname, '..', 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(configData);
}

async function testBotCommands() {
    const config = loadConfig();
    
    if (!config.telegram?.botToken) {
        console.error('❌ 配置中未找到Telegram机器人令牌');
        process.exit(1);
    }
    
    console.log('🔍 测试Telegram机器人命令设置...');
    
    try {
        // 创建机器人实例但不启动轮询
        const bot = new TelegramBot(config.telegram.botToken, { polling: false });
        
        // 获取机器人信息
        const botInfo = await bot.getMe();
        console.log('✅ 机器人信息:');
        console.log('   - 用户名:', botInfo.username);
        console.log('   - 名称:', botInfo.first_name);
        console.log('   - ID:', botInfo.id);
        
        // 获取当前命令设置
        console.log('\n📋 检查命令设置...');
        
        // 获取所有私聊命令
        const privateCommands = await bot.getMyCommands({
            scope: { type: 'all_private_chats' }
        });
        console.log('🔸 私聊命令:');
        privateCommands.forEach(cmd => {
            console.log(`   /${cmd.command} - ${cmd.description}`);
        });
        
        // 获取所有群组命令
        const groupCommands = await bot.getMyCommands({
            scope: { type: 'all_group_chats' }
        });
        console.log('🔸 群组命令:');
        groupCommands.forEach(cmd => {
            console.log(`   /${cmd.command} - ${cmd.description}`);
        });
        
        // 获取管理员的命令设置
        const config = loadConfig();
        const adminId = config.telegram.adminUserId;
        
        let adminCommands = [];
        if (adminId) {
            try {
                adminCommands = await bot.getMyCommands({
                    scope: { 
                        type: 'chat',
                        chat_id: parseInt(adminId)
                    }
                });
                console.log('🔸 管理员命令:');
                adminCommands.forEach(cmd => {
                    console.log(`   /${cmd.command} - ${cmd.description}`);
                });
            } catch (error) {
                console.log('⚠️ 无法获取管理员命令:', error.message);
            }
        }
        
        // 验证设置是否正确
        console.log('\n✅ 验证结果:');
        
        if (groupCommands.length === 1 && groupCommands[0].command === 'help') {
            console.log('✅ 群组命令设置正确：只显示 /help 命令');
        } else {
            console.log('❌ 群组命令设置错误');
        }
        
        if (privateCommands.length === 5) {
            console.log('✅ 普通用户私聊命令设置正确：5个命令（不包含refresh）');
        } else {
            console.log(`❌ 普通用户私聊命令设置错误：期望5个，实际${privateCommands.length}个`);
        }
        
        if (adminCommands.length >= 9) {
            console.log('✅ 管理员命令设置正确：包含管理员专用命令');
        } else if (adminCommands.length > 0) {
            console.log(`⚠️ 管理员命令可能不完整：期望至少9个，实际${adminCommands.length}个`);
        } else {
            console.log('⚠️ 未检测到管理员专用命令设置');
        }
        
    } catch (error) {
        console.error('❌ 测试失败:', error.message);
        process.exit(1);
    }
}

testBotCommands().then(() => {
    console.log('\n🎉 测试完成！');
    process.exit(0);
}).catch(error => {
    console.error('❌ 测试出错:', error);
    process.exit(1);
}); 