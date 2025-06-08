const fs = require('fs');
const path = require('path');

class UserValidator {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        
        this.userActivities = new Map();
        
        // 数据文件路径
        this.dataDir = path.join(__dirname, '../../../data');
        this.activitiesFile = path.join(this.dataDir, 'user-activities.json');
        
        this.ensureDataDirectory();
        this.loadActivities();
    }
    
    ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }
    
    loadActivities() {
        try {
            if (fs.existsSync(this.activitiesFile)) {
                const activitiesData = JSON.parse(fs.readFileSync(this.activitiesFile, 'utf8'));
                
                for (const [userId, activity] of Object.entries(activitiesData)) {
                    this.userActivities.set(parseInt(userId), activity);
                }
                
                this.logger.info(`Loaded ${this.userActivities.size} user activities`);
            }
        } catch (error) {
            this.logger.error('Error loading user activities:', error);
        }
    }
    
    saveData() {
        try {
            const activitiesData = Object.fromEntries(this.userActivities);
            fs.writeFileSync(this.activitiesFile, JSON.stringify(activitiesData, null, 2));
        } catch (error) {
            this.logger.error('Error saving user activities:', error);
        }
    }
    
    recordUserActivity(userId, username) {
        const activity = {
            userId: userId,
            username: username,
            lastSeen: Date.now(),
            lastUpdate: Date.now()
        };
        
        this.userActivities.set(userId, activity);
    }
    
    async validateAllUsers() {
        // 这里可以添加用户验证逻辑
        // 例如检查用户是否还在群组中等
        this.logger.debug('Validating all users...');
    }
    
    async revokeUserAccess(userId, reason) {
        // 撤销用户访问权限
        this.userActivities.delete(userId);
        this.logger.info(`Revoked access for user ${userId}: ${reason}`);
    }
    
    getUserCount() {
        return this.userActivities.size;
    }
    
    getActiveUsers() {
        const now = Date.now();
        const activeThreshold = 24 * 60 * 60 * 1000; // 24小时
        
        return Array.from(this.userActivities.values()).filter(activity => 
            now - activity.lastSeen < activeThreshold
        );
    }
    
    isUserActive(userId) {
        const activity = this.userActivities.get(userId);
        if (!activity) return false;
        
        const now = Date.now();
        const activeThreshold = 24 * 60 * 60 * 1000; // 24小时
        
        return now - activity.lastSeen < activeThreshold;
    }
}

module.exports = UserValidator; 