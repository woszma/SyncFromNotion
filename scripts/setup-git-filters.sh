#!/bin/bash

# Git Filter 初始化脚本
# 
# 此脚本配置本地 Git 仓库，使 manifest.json 在提交时自动移除 id 字段
# 
# 使用方法：
# chmod +x scripts/setup-git-filters.sh
# ./scripts/setup-git-filters.sh

set -e

echo "🔧 设置 Figma 插件 Manifest ID Git Filter..."

# 获取脚本所在目录的绝对路径
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# 配置 Git filter
echo "📝 配置 Git clean filter..."
git config filter.manifest-id.clean "node '${PROJECT_ROOT}/scripts/remove-manifest-id.js'"
git config filter.manifest-id.smudge cat

# 验证配置
echo ""
echo "✅ Git filter 配置完成！"
echo ""
echo "配置信息："
git config --get filter.manifest-id.clean
git config --get filter.manifest-id.smudge

echo ""
echo "📌 提示："
echo "  - 本地的 manifest.json 可以包含 'id' 字段（Figma 开发时需要）"
echo "  - 提交到 Git 时会自动移除 'id' 字段"
echo "  - 您的本地文件不会被修改"
echo ""
echo "🎉 设置完成！您可以正常开发了。"
