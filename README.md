# Xtream Codes Proxy

一个功能强大的IPTV代理服务器，集成Telegram机器人管理，提供安全的IPTV访问控制和用户管理功能。

## 🌟 主要特性

### 🔐 安全访问控制
- **群组权限验证**：只有指定Telegram群组的成员才能获得订阅链接
- **24小时自动过期**：生成的链接在24小时内自动失效，无需IP验证
- **自动过期提醒**：机器人会在链接过期前自动推送提醒消息
- **令牌验证系统**：通过临时令牌验证用户身份

### 🤖 Telegram机器人集成
- **私聊操作**：所有敏感操作都在私聊中进行，保护用户隐私
- **群组成员监控**：自动监控群组成员变化，离开群组自动撤销权限
- **管理员功能**：完整的管理员面板和权限管理
- **多语言支持**：支持中文界面

### 📺 IPTV功能
- **M3U播放列表**：支持标准M3U和M3U Plus格式
- **频道管理**：自动获取和管理IPTV频道
- **并发控制**：限制用户同时播放的设备数量
- **流量监控**：实时监控用户使用情况

## 🚀 快速开始

### 环境要求
- Node.js 16.0 或更高版本
- npm 或 yarn 包管理器

### 安装步骤

1. **克隆项目**
```bash
git clone <repository-url>
cd xtream-proxy
```

2. **安装依赖**
```bash
npm install
```

3. **配置文件**
```bash
cp config.json.example config.json
```

4. **编辑配置文件**
```bash
nano config.json
```

5. **启动服务**
```bash
npm start
```

## ⚙️ 配置说明

### 服务器配置 (server)
```json
{
  "server": {
    "port": 8080,                    // 服务器端口
    "host": "0.0.0.0",              // 监听地址
    "externalUrl": "http://localhost:8080"  // 外部访问URL
  }
}
```

### 原始服务器配置 (originalServer)
```json
{
  "originalServer": {
    "url": "https://example.com/playlist.m3u",  // M3U播放列表URL
    "m3uPath": "",                              // M3U文件路径（可选）
    "timeout": 10000,                           // 请求超时时间（毫秒）
    "autoRefreshInterval": 7200000,             // 自动刷新间隔（毫秒）
    "enableAutoRefresh": true                   // 启用自动刷新
  }
}
```

### Telegram机器人配置 (telegram)
```json
{
  "telegram": {
    "botToken": "YOUR_BOT_TOKEN",               // 机器人Token
    "groupId": "-1001234567890",                // 授权群组ID
    "adminUserId": "123456789",                 // 主管理员ID
    "adminUserIds": ["123456789", "987654321"], // 管理员ID列表
    "tokenExpiry": 600000,                      // 令牌有效期（10分钟）
    "maxTokensPerUser": 2,                      // 每用户每日最大令牌数
    "tokenGenerationPeriod": 86400000           // 令牌生成周期（24小时）
  }
}
```

### 安全配置 (security)
```json
{
  "security": {
    "connectionTimeout": 60000,      // 连接超时时间
    "cleanupInterval": 20000,        // 清理间隔
    "enableLogging": true,           // 启用日志记录
    "allowedIPs": [],               // 允许的IP列表（空为允许所有）
    "blockedIPs": [],               // 阻止的IP列表
    "enableIPBinding": false,        // 启用IP绑定
    "redirectTokenExpiry": 7200000,  // 重定向令牌过期时间
    "maxTokenUsage": 3              // 最大令牌使用次数
  }
}
```

### 播放列表配置 (playlist)
```json
{
  "playlist": {
    "refreshLimitPeriod": 18000000,              // 刷新限制周期
    "maxRefreshesBeforeExpiry": 6,               // 过期前最大刷新次数
    "maxSimultaneousPlaylists": 3,               // 最大同时播放列表数
    "defaultLinkExpiry": 86400000,               // 默认链接过期时间（24小时）
    "enablePersistentStorage": true,             // 启用持久化存储
    "persistentStorageCleanupInterval": 86400000, // 存储清理间隔
    "enablePermanentUsers": false,               // 启用永久用户
    "userLinkExpiry": 86400000,                 // 用户链接过期时间（24小时）
    "expiryNotificationHours": [24, 12, 1]      // 过期提醒时间点
  }
}
```

### 功能配置 (features)
```json
{
  "features": {
    "enableAdmin": true,             // 启用管理员功能
    "enableStatus": true,            // 启用状态查询
    "enableEPG": true,              // 启用电子节目指南
    "cacheChannels": true,          // 缓存频道信息
    "channelRefreshInterval": 3600000, // 频道刷新间隔
    "enableTelegramBot": true,       // 启用Telegram机器人
    "filterChannels": {
      "enabled": true,               // 启用频道过滤
      "blacklistKeywords": [],       // 黑名单关键词
      "whitelistKeywords": []        // 白名单关键词
    }
  }
}
```

## 🤖 Telegram机器人使用

### 用户命令

#### 基础命令
- `/start` - 开始使用机器人
- `/help` - 显示帮助信息
- `/gettoken` - 获取访问令牌
- `/mycredentials` - 查看登录凭据

#### 获取访问权限流程
1. **加入授权群组**：确保您已加入指定的Telegram群组
2. **私聊机器人**：点击机器人头像开始私聊
3. **获取令牌**：使用 `/gettoken` 命令获取8位访问令牌
4. **验证令牌**：在私聊中直接发送令牌进行验证
5. **获得凭据**：验证成功后自动获得24小时有效的播放列表链接

### 管理员命令

#### 系统管理
- `/admin` - 管理员面板
- `/status` - 查看服务器状态
- `/refresh` - 刷新频道列表

#### 权限管理
- `/addadmin <用户ID>` - 添加管理员
- `/removeadmin <用户ID>` - 移除管理员
- `/listadmins` - 查看管理员列表

#### 配置管理
- `/changem3u <新链接>` - 修改M3U订阅链接

## 🔒 权限控制机制

### 群组权限验证
- 只有指定群组的成员才能使用机器人功能
- 非群组成员尝试使用时会收到"你没有权限获得链接"的提示
- 离开群组后自动撤销所有访问权限

### 24小时自动过期
- 每次验证令牌后获得24小时访问权限
- 链接不需要IP验证，可在任何设备上使用
- 过期后需要重新获取令牌来续期

### 自动提醒系统
- 链接过期前24小时自动发送提醒
- 过期后立即发送过期通知
- 提供详细的续期指导

## 📱 支持的播放器

### 推荐播放器
- **IPTV Smarters Pro** - 功能全面，支持EPG
- **TiviMate** - 界面美观，性能优秀
- **VLC Media Player** - 开源免费，兼容性好
- **Perfect Player** - 轻量级，启动快速
- **GSE Smart IPTV** - 功能丰富，自定义性强

### 播放列表格式
- **M3U Plus格式**：`/get.php?username=用户名&password=密码&type=m3u_plus`
- 包含完整的频道信息和分类
- 支持EPG电子节目指南

## 🛡️ 安全特性

### 访问控制
- 群组成员身份验证
- 临时令牌验证机制
- 自动过期保护

### 使用限制
- 每用户每日最多生成2个令牌
- 每小时最多刷新10次播放列表
- 最多3个设备同时播放

### 监控功能
- 实时监控用户活动
- 自动清理过期数据
- 详细的访问日志

## 📊 监控和日志

### 系统状态
- 服务器运行时间
- 内存使用情况
- 活跃用户统计
- 频道数量统计

### 日志记录
- 用户认证日志
- 访问请求日志
- 错误和异常日志
- 系统操作日志

## 🔧 故障排除

### 常见问题

#### 1. 机器人无响应
- 检查bot token是否正确
- 确认机器人已启动
- 查看网络连接状态

#### 2. 权限验证失败
- 确认用户在指定群组中
- 检查群组ID配置
- 验证管理员权限

#### 3. 播放列表无法加载
- 检查M3U链接有效性
- 确认网络连接正常
- 查看服务器日志

#### 4. 链接过期问题
- 使用 `/gettoken` 重新获取
- 检查系统时间设置
- 确认配置文件正确

### 日志查看
```bash
# 查看实时日志
tail -f logs/app.log

# 查看错误日志
tail -f logs/error.log
```

## 🚀 部署建议

### 生产环境
- 使用PM2进程管理器
- 配置反向代理（Nginx）
- 启用HTTPS加密
- 定期备份配置和数据

### Docker部署
```bash
# 构建镜像
docker build -t xtream-proxy .

# 运行容器
docker run -d -p 8080:8080 -v ./config.json:/app/config.json xtream-proxy
```

### 使用Docker Compose
```bash
docker-compose up -d
```

## 📝 更新日志

### 最新版本特性
- ✅ 群组权限严格控制
- ✅ 24小时链接自动过期
- ✅ 自动过期提醒推送
- ✅ 无需IP验证的链接生成
- ✅ 完整的中文界面支持

## 🤝 贡献指南

欢迎提交Issue和Pull Request来改进项目。

### 开发环境设置
```bash
# 克隆项目
git clone <repository-url>
cd xtream-proxy

# 安装依赖
npm install

# 开发模式运行
npm run dev
```

## 📄 许可证

本项目采用MIT许可证，详见LICENSE文件。

## 📞 支持

如有问题或建议，请：
1. 查看故障排除部分
2. 提交GitHub Issue
3. 联系项目维护者

---

**注意**：请确保遵守当地法律法规，合理使用IPTV服务。 