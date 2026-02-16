#!/usr/bin/env node

/**
 * Git Clean Filter for manifest.json
 * 
 * 此脚本在 git add 时执行，自动移除 manifest.json 中的 "id" 字段
 * 确保仓库中永远不会包含设备特定的插件 ID
 * 
 * 使用方法：
 * - 通过 .gitattributes 自动触发
 * - 或手动测试：node scripts/remove-manifest-id.js < manifest.json
 */

const fs = require('fs');

// 从 stdin 读取内容
let input = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', chunk => {
  input += chunk;
});

process.stdin.on('end', () => {
  try {
    // 解析 JSON
    const manifest = JSON.parse(input);
    
    // 移除 id 字段（如果存在）
    if ('id' in manifest) {
      delete manifest.id;
    }
    
    // 输出格式化的 JSON（保持 2 空格缩进，与原文件一致）
    const output = JSON.stringify(manifest, null, 2) + '\n';
    process.stdout.write(output);
    
  } catch (error) {
    // 如果解析失败，输出原始内容（避免破坏文件）
    console.error('Warning: Failed to parse manifest.json, returning original content', error.message);
    process.stdout.write(input);
  }
});

process.stdin.on('error', error => {
  console.error('Error reading stdin:', error);
  process.exit(1);
});
