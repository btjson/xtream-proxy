# 🎬 Xtream Codes Proxy

一个功能强大的Xtream Codes格式IPTV代理服务器，支持M3U播放列表转换、用户认证、Telegram机器人管理和多种安全特性。

## ✨ 主要特性

- 🔄 **M3U到Xtream Codes转换**: 将标准M3U播放列表转换为Xtream Codes API格式
- 👥 **用户管理**: 支持多用户认证和权限管理
- 🤖 **Telegram机器人**: 自动化用户管理和token分发
- 🔒 **安全特性**: IP白名单/黑名单、速率限制、加密token
- 📺 **频道管理**: 自动刷新频道列表、分类管理、频道过滤
- 🎯 **API兼容**: 完全兼容Xtream Codes API规范
- 📊 **管理面板**: Web界面管理用户和服务器状态
- 🚀 **高性能**: 支持大量并发连接和流代理

## 📁 项目结构

```
xtream-proxy/
├── src/                          # 源代码目录
│   ├── app.js                   # 主应用入口
│   ├── managers/                # 管理器模块
│   │   ├── UserManager.js       # 用户管理
│   │   ├── ChannelManager.js    # 频道管理
│   │   ├── SecurityManager.js   # 安全管理
│   │   └── TelegramBotManager.js # Telegram机器人管理
│   ├── routes/                  # 路由模块
│   │   ├── player.js           # Player API路由
│   │   ├── admin.js            # 管理员路由
│   │   └── stream.js           # 流媒体路由
│   ├── utils/                   # 工具类
│   │   ├── ConfigManager.js    # 配置管理
│   │   └── Logger.js           # 日志管理
│   └── managers/telegram/       # Telegram子模块
│       ├── TokenManager.js     # Token管理
│       ├── CommandHandler.js   # 命令处理
│       ├── AdminHandler.js     # 管理员命令
│       └── UserValidator.js    # 用户验证
├── data/                        # 数据存储目录
├── logs/                        # 日志目录
├── config.json                  # 配置文件
├── package.json                 # 项目依赖
└── index.js                     # 应用入口点
```

## 🚀 快速开始

### 环境要求

- **Node.js**: >= 14.0.0
- **npm**: >= 6.0.0
- **内存**: 建议 >= 512MB
- **操作系统**: Linux/Windows/macOS

### 安装步骤

1. **克隆仓库**
   ```bash
   git clone https://github.com/your-username/xtream-codes-proxy.git
   cd xtream-codes-proxy
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **配置服务器**
   ```bash
   cp config.json.example config.json
   nano config.json
   ```

4. **启动服务器**
   ```bash
   # 开发模式
   npm run dev
   
   # 生产模式
   npm start
   
   # 使用PM2管理（推荐生产环境）
   npm run install-pm2
   npm run start-pm2
   ```

### Docker 部署

1. **构建镜像**
   ```bash
   docker build -t xtream-proxy .
   ```

2. **运行容器**
   ```bash
   docker run -d \
     --name xtream-proxy \
     -p 8080:8080 \
     -v $(pwd)/config.json:/app/config.json \
     -v $(pwd)/data:/app/data \
     xtream-proxy
   ```

3. **使用Docker Compose**
   ```bash
   docker-compose up -d
   ```

## ⚙️ 配置说明

### 基本配置

```json
{
  "server": {
    "port": 8080,
    "host": "0.0.0.0"
  },
  "originalServer": {
    "url": "https://your-m3u-server.com",
    "m3uPath": "/playlist.m3u",
    "timeout": 10000,
    "autoRefreshInterval": 7200000,
    "enableAutoRefresh": true
  }
}
```

### Telegram机器人配置

```json
{
  "telegram": {
    "botToken": "YOUR_BOT_TOKEN",
    "groupId": "-1001234567890",
    "adminUserIds": ["123456789"],
    "tokenExpiry": 600000,
    "maxTokensPerUser": 2,
    "tokenGenerationPeriod": 86400000
  }
}
```

### 安全配置

```json
{
  "security": {
    "enableLogging": true,
    "allowedIPs": [],
    "blockedIPs": [],
    "enableIPBinding": false,
    "redirectTokenExpiry": 7200000,
    "maxTokenUsage": 3
  }
}
```

### 用户管理

```json
{
  "users": {
    "admin": {
      "password": "admin123",
      "maxConnections": 1,
      "enabled": true
    }
  }
}
```

## 🤖 Telegram机器人设置

### 1. 创建机器人

1. 联系 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 创建新机器人
3. 设置机器人名称和用户名
4. 获取Bot Token

### 2. 设置群组

1. 创建Telegram群组
2. 将机器人添加到群组
3. 设置机器人为管理员
4. 获取群组ID

### 3. 获取群组ID

```bash
# 发送消息到群组后访问：
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```

### 4. 配置机器人命令

机器人支持以下命令：

- `/start` - 开始使用机器人
- `/help` - 显示帮助信息
- `/gettoken` - 获取访问令牌
- `/mycredentials` - 查看我的凭据
- `/status` - 查看服务器状态
- `/refresh` - 刷新频道列表
- `/admin` - 管理员命令（仅管理员）

## 📡 API 使用指南

### Xtream Codes API

服务器提供完整的Xtream Codes API兼容接口：

```bash
# 获取用户信息
http://your-server:8080/player_api.php?username=USER&password=PASS&action=get_live_categories

# 获取直播分类
http://your-server:8080/player_api.php?username=USER&password=PASS&action=get_live_categories

# 获取直播流
http://your-server:8080/player_api.php?username=USER&password=PASS&action=get_live_streams

# 播放直播流
http://your-server:8080/live/USERNAME/PASSWORD/STREAM_ID.ts
```

### M3U播放列表

```bash
# 获取M3U播放列表
http://your-server:8080/get.php?username=USER&password=PASS&type=m3u_plus&output=ts
```

### XMLTV EPG

```bash
# 获取EPG数据
http://your-server:8080/xmltv.php?username=USER&password=PASS
```

## 🔧 管理功能

### Web管理面板

访问 `http://your-server:8080/admin` 进入管理面板，可以：

- 查看服务器状态和统计信息
- 管理用户账户
- 刷新频道列表
- 查看系统日志

### 用户管理API

```bash
# 获取用户列表
GET /admin/users

# 创建用户
POST /admin/users
{
  "username": "newuser",
  "password": "password123",
  "maxConnections": 1,
  "enabled": true
}

# 更新用户
PUT /admin/users/username
{
  "enabled": false
}

# 删除用户
DELETE /admin/users/username
```

### 系统监控

```bash
# 健康检查
GET /health

# 服务器状态
GET /admin/status
```

## 🛠️ 开发指南

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 运行测试
npm test
```

### 代码结构

项目采用模块化设计：

- **管理器 (Managers)**: 处理核心业务逻辑
- **路由 (Routes)**: 处理HTTP请求路由
- **工具类 (Utils)**: 提供通用功能
- **配置管理**: 统一的配置管理系统

### 添加新功能

1. 在相应的管理器中添加业务逻辑
2. 在路由中添加API端点
3. 更新配置文件模式
4. 添加相关测试

## 🔍 故障排除

### 常见问题

**Q: 服务器启动失败**
```bash
# 检查端口是否被占用
netstat -tlnp | grep 8080

# 检查配置文件格式
node -e "console.log(JSON.parse(require('fs').readFileSync('config.json')))"
```

**Q: Telegram机器人无响应**
```bash
# 检查Bot Token是否正确
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe

# 检查网络连接
curl https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

**Q: 频道列表为空**
```bash
# 手动刷新频道
curl -X POST http://localhost:8080/admin/refresh-channels

# 检查原始服务器连接
curl -I "YOUR_M3U_SERVER_URL"
```

### 日志查看

```bash
# 查看应用日志
tail -f logs/app-$(date +%Y-%m-%d).log

# 查看PM2日志
npm run logs-pm2

# 启用详细日志
# 在config.json中设置 "enableLogging": true
```

### 性能优化

1. **启用频道缓存**
   ```json
   {
     "features": {
       "cacheChannels": true,
       "channelRefreshInterval": 3600000
     }
   }
   ```

2. **调整安全参数**
   ```json
   {
     "security": {
       "connectionTimeout": 60000,
       "cleanupInterval": 20000
     }
   }
   ```

3. **使用PM2集群模式**
   ```bash
   pm2 start index.js --name xtream-proxy -i max
   ```

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🤝 贡献

欢迎贡献代码！请遵循以下步骤：

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

## 📞 支持

如果您遇到问题或需要帮助：

1. 查看 [Issues](https://github.com/your-username/xtream-codes-proxy/issues)
2. 创建新的 Issue
3. 联系维护者

## 🔄 版本历史

### v2.0.0 (重构版本)
- ✨ 完全重构代码结构
- 🏗️ 模块化设计
- 🔧 改进的配置管理
- 📊 增强的管理面板
- 🛡️ 更好的安全特性

### v1.0.0 (初始版本)
- 🎯 基本的Xtream Codes代理功能
- 🤖 Telegram机器人支持
- 👥 用户管理系统

---

**项目维护者**: [Your Name](https://github.com/your-username)
**最后更新**: 2024年12月 