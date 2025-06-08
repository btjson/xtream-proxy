const fs = require('fs');
const path = require('path');

class Logger {
    constructor(config) {
        this.config = config;
        this.logsDir = path.join(__dirname, '../../logs');
        this.enableLogging = config.security?.enableLogging || false;
        
        if (this.enableLogging) {
            this.ensureLogsDirectory();
        }
    }
    
    ensureLogsDirectory() {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }
    
    formatTimestamp() {
        return new Date().toISOString();
    }
    
    log(level, message, metadata = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            message,
            ...metadata
        };
        
        // 只在控制台显示信息、警告和错误
        if (['info', 'warn', 'error'].includes(level)) {
            console.log(`[${logEntry.level}] ${logEntry.message}`);
        }
        
        if (this.enableLogging) {
            const logLine = `${timestamp} [${level.toUpperCase()}] ${message}${Object.keys(metadata).length > 0 ? ' ' + JSON.stringify(metadata) : ''}\n`;
            this.writeToFile(logLine);
        }
    }
    
    getColoredLevel(level) {
        const colors = {
            info: '\x1b[36m',    // Cyan
            warn: '\x1b[33m',    // Yellow
            error: '\x1b[31m',   // Red
            debug: '\x1b[37m',   // White
            success: '\x1b[32m'  // Green
        };
        
        const reset = '\x1b[0m';
        const color = colors[level] || colors.info;
        
        return `${color}[${level.toUpperCase()}]${reset}`;
    }
    
    writeToFile(logLine) {
        try {
            const logFileName = `app-${new Date().toISOString().split('T')[0]}.log`;
            const logFilePath = path.join(this.logsDir, logFileName);
            
            fs.appendFileSync(logFilePath, logLine);
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }
    
    info(message, metadata = {}) {
        this.log('info', message, metadata);
    }
    
    warn(message, metadata = {}) {
        this.log('warn', message, metadata);
    }
    
    error(message, metadata = {}) {
        this.log('error', message, metadata);
    }
    
    debug(message, metadata = {}) {
        this.log('debug', message, metadata);
    }
    
    success(message, metadata = {}) {
        this.log('success', message, metadata);
    }
    
    // 清理旧日志文件
    cleanupOldLogs(daysToKeep = 30) {
        if (!this.enableLogging) return;
        
        try {
            const files = fs.readdirSync(this.logsDir);
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
            
            files.forEach(file => {
                if (file.endsWith('.log')) {
                    const filePath = path.join(this.logsDir, file);
                    const stats = fs.statSync(filePath);
                    
                    if (stats.mtime < cutoffDate) {
                        fs.unlinkSync(filePath);
                        this.info(`Deleted old log file: ${file}`);
                    }
                }
            });
        } catch (error) {
            this.error('Error cleaning up old logs:', error);
        }
    }
    
    // Utility function to truncate long URLs for logging
    static truncateUrlForLogging(url) {
        if (!url) return url;
        
        // Check if it's an encrypted token URL
        if (url.includes('/live/encrypted/') || url.includes('/stream/encrypted/')) {
            const parts = url.split('?');
            const baseUrl = parts[0];
            const queryParams = parts[1];
            
            // Extract the encrypted token path
            const tokenMatch = baseUrl.match(/\/encrypted\/([^\/]+)/);
            if (tokenMatch && tokenMatch[1].length > 50) {
                const truncatedToken = tokenMatch[1].substring(0, 20) + '...[' + (tokenMatch[1].length - 40) + ' chars]...' + tokenMatch[1].substring(tokenMatch[1].length - 20);
                const truncatedBaseUrl = baseUrl.replace(tokenMatch[1], truncatedToken);
                return queryParams ? `${truncatedBaseUrl}?${queryParams}` : truncatedBaseUrl;
            }
        }
        
        // For other long URLs, truncate if longer than 150 characters
        if (url.length > 150) {
            return url.substring(0, 75) + '...[' + (url.length - 150) + ' chars]...' + url.substring(url.length - 75);
        }
        
        return url;
    }
}

module.exports = Logger; 