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
    
    log(level, message, data = null) {
        const timestamp = this.formatTimestamp();
        const logEntry = {
            timestamp,
            level,
            message,
            data
        };
        
        // 控制台输出
        const coloredLevel = this.getColoredLevel(level);
        console.log(`[${timestamp}] ${coloredLevel} ${message}`, data ? data : '');
        
        // 文件输出
        if (this.enableLogging) {
            this.writeToFile(logEntry);
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
    
    writeToFile(logEntry) {
        try {
            const logFileName = `app-${new Date().toISOString().split('T')[0]}.log`;
            const logFilePath = path.join(this.logsDir, logFileName);
            const logLine = JSON.stringify(logEntry) + '\n';
            
            fs.appendFileSync(logFilePath, logLine);
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }
    
    info(message, data = null) {
        this.log('info', message, data);
    }
    
    warn(message, data = null) {
        this.log('warn', message, data);
    }
    
    error(message, data = null) {
        this.log('error', message, data);
    }
    
    debug(message, data = null) {
        this.log('debug', message, data);
    }
    
    success(message, data = null) {
        this.log('success', message, data);
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
}

module.exports = Logger; 