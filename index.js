// 安全的TLS配置
const tls = require('tls');
const crypto = require('crypto');

// 设置默认的TLS选项（更安全的方式）
tls.DEFAULT_ECDH_CURVE = 'auto';
tls.DEFAULT_MIN_VERSION = 'TLSv1.2';
tls.DEFAULT_MAX_VERSION = 'TLSv1.3';

// 只在开发环境中禁用TLS验证
if (process.env.NODE_ENV === 'development') {
    console.log('⚠️  Development mode: TLS certificate verification disabled');
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;
}

const XtreamCodesProxy = require('./src/app');

async function main() {
    try {
        console.log('🚀 Starting Xtream Codes Proxy Server...');
        console.log('📋 Environment:', process.env.NODE_ENV || 'production');
        console.log('📋 Node.js version:', process.version);
        console.log('📋 Platform:', process.platform);
        
        const app = new XtreamCodesProxy();
        await app.start();
        
        console.log('✅ Server started successfully!');
        
        // 优雅关闭处理
        process.on('SIGINT', () => {
            console.log('\n🛑 Received SIGINT, shutting down gracefully...');
            app.gracefulShutdown();
        });
        
        process.on('SIGTERM', () => {
            console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
            app.gracefulShutdown();
        });
        
    } catch (error) {
        console.error('❌ Failed to start application:', error);
        process.exit(1);
    }
}

main();