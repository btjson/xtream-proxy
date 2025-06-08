# 故障排除指南

## 常见问题及解决方案

### 1. Telegram机器人冲突错误 (409 Conflict)

**错误信息:**
```
ETELEGRAM: 409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running
```

**原因:**
- 有多个程序同时使用同一个机器人令牌
- 之前的程序没有正确关闭
- Webhook配置与轮询模式冲突

**解决方案:**

#### 方法1: 检查机器人状态
```bash
node scripts/check-bot-status.js
```

#### 方法2: 清理Webhook配置
```bash
node scripts/clear-webhook.js
```

#### 方法3: 手动解决
1. **停止所有相关程序**
   ```bash
   # 查找所有Node.js进程
   ps aux | grep node
   
   # 停止特定进程
   kill -9 <进程ID>
   ```

2. **等待Telegram服务器清理连接**
   - 等待30-60秒让Telegram服务器自动清理连接

3. **重新启动程序**
   ```bash
   npm start
   ```

### 2. 优雅关闭错误

**错误信息:**
```
TypeError: app.gracefulShutdown is not a function
```

**解决方案:**
这个问题已经在最新版本中修复。确保你使用的是最新代码。

### 3. TLS证书警告

**错误信息:**
```
NODE_TLS_REJECT_UNAUTHORIZED warning
```

**解决方案:**
- 在生产环境中，确保使用有效的TLS证书
- 在开发环境中，设置环境变量：
  ```bash
  export NODE_ENV=development
  ```

### 4. 端口占用错误

**错误信息:**
```
Error: listen EADDRINUSE :::3000
```

**解决方案:**
1. **查找占用端口的进程**
   ```bash
   lsof -i :3000
   ```

2. **停止占用进程**
   ```bash
   kill -9 <进程ID>
   ```

3. **或者更改端口**
   在`config.json`中修改端口号：
   ```json
   {
     "server": {
       "port": 3001
     }
   }
   ```

## 预防措施

### 1. 正确关闭程序
始终使用`Ctrl+C`来正确关闭程序，这会触发优雅关闭流程。

### 2. 避免重复启动
在启动新实例之前，确保之前的实例已完全关闭。

### 3. 监控日志
定期检查日志文件以发现潜在问题：
```bash
tail -f logs/app.log
```

### 4. 使用进程管理器
考虑使用PM2等进程管理器来管理应用：
```bash
npm install -g pm2
pm2 start index.js --name xtream-proxy
pm2 logs xtream-proxy
pm2 restart xtream-proxy
pm2 stop xtream-proxy
```

## 调试技巧

### 1. 启用详细日志
在`config.json`中启用调试模式：
```json
{
  "security": {
    "enableLogging": true
  }
}
```

### 2. 检查配置文件
确保`config.json`格式正确：
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('config.json', 'utf8')))"
```

### 3. 测试网络连接
```bash
# 测试Telegram API连接
curl -s "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getMe"

# 测试上游服务器连接
curl -s "http://your-upstream-server.com/get.php?username=test&password=test"
```

## 获取帮助

如果问题仍然存在，请提供以下信息：

1. **错误日志**
   ```bash
   tail -n 50 logs/app.log
   ```

2. **系统信息**
   ```bash
   node --version
   npm --version
   uname -a
   ```

3. **配置信息**（隐藏敏感信息）
   ```bash
   cat config.json | sed 's/"botToken": ".*"/"botToken": "HIDDEN"/g'
   ```

4. **进程信息**
   ```bash
   ps aux | grep node
   netstat -tulpn | grep :3000
   ``` 