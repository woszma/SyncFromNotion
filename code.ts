// ====================================================================
// SyncFromNotion v2 — Figma Plugin Backend (Sandbox)
// 從 Notion (via Make.com Webhook) 同步數據到 Figma 畫布
// 核心: 用戶選擇 Component → 映射數據欄位到圖層 → 生成 Instance
// ====================================================================

// --- 類型定義 ---
interface FieldMapping {
  layerName: string;    // Component 中的圖層名稱
  dataField: string;    // Webhook 數據中的欄位名
  dataType: 'text' | 'image';  // 數據類型
}

interface SyncRequest {
  componentId: string;
  data: Record<string, any>[];
  mappings: FieldMapping[];
  idField: string;       // 用作唯一 ID 的數據欄位
}

// --- 常量 ---
const PLUGIN_DATA_KEY = 'notionId';
const PLUGIN_DATA_COMPONENT = 'sourceComponentId';
const CARD_GAP = 20;
const CARDS_PER_ROW = 4;
const VERSION = '1.2.0'; // Version Control

// --- 主程式 ---
figma.showUI(__html__, { width: 420, height: 520 });
figma.ui.postMessage({ type: 'version-info', version: VERSION });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
figma.ui.onmessage = async (msg: any) => {
  if (msg.type === 'cancel') {
    figma.closePlugin();
    return;
  }

  // ================================================================
  // Step 2：讀取所選 Component 的圖層結構
  // ================================================================
  if (msg.type === 'get-component-layers') {
    console.log('收到 get-component-layers 请求');
    try {
      const selection = figma.currentPage.selection;
      console.log('當前選擇:', selection);

      if (selection.length === 0) {
        figma.ui.postMessage({
          type: 'error',
          message: '請先在畫布上選擇一個 Component'
        });
        return;
      }

      const selected = selection[0];
      let component: ComponentNode | null = null;

      if (selected.type === 'COMPONENT') {
        component = selected as ComponentNode;
      } else if (selected.type === 'INSTANCE') {
        component = (selected as InstanceNode).mainComponent;
      } else if (selected.type === 'COMPONENT_SET') {
        const compSet = selected as ComponentSetNode;
        if (compSet.children.length > 0) {
          component = compSet.children[0] as ComponentNode;
        }
      } else if (selected.type === 'FRAME' || selected.type === 'GROUP') {
        // [New] Allow Frames and Groups to be used as templates
        component = selected as unknown as ComponentNode; // Cast for now, but we handle it generically
      }

      if (!component) {
        console.error('選擇的節點不是有效的 Template:', selected.type);
        figma.ui.postMessage({
          type: 'error',
          message: `選擇的是 ${selected.type}，請選擇 Component、Instance、Frame 或 Group。`
        });
        return;
      }

      console.log('找到 Component:', component.name, component.id);
      const layers = collectLayers(component);
      const mappingId = getMappingId(component);
      console.log('找到 Component:', component.name, 'Mapping ID:', mappingId);
      console.log('收集到圖層數量:', layers.length);

      figma.ui.postMessage({
        type: 'component-layers',
        componentId: mappingId,
        actualTemplateId: component.id, // [New] Pass back the specific node ID
        componentName: component.name,
        layers: layers
      });

    } catch (e) {
      console.error('讀取 Component 失敗:', e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      figma.ui.postMessage({ type: 'error', message: `讀取 Component 失敗: ${errorMsg}` });
    }
    return;
  }

  // ================================================================
  // 單張圖片嵌入（逐張從 UI 傳來）
  // ================================================================
  if (msg.type === 'set-image') {
    try {
      const { notionId, layerName, imageBytes, imageUrl } = msg;
      if (!notionId || !imageBytes || !layerName) return;

      const existingMap = buildExistingMap();
      const nodes = existingMap.get(notionId); // 现在返回数组

      // 更新所有使用此 ID 的 instance
      if (nodes && nodes.length > 0) {
        for (const node of nodes) {
          if ('children' in node) {
            const frame = node as FrameNode;
            const imageData = new Uint8Array(imageBytes);
            const image = figma.createImage(imageData);

            const targetLayer = findChildByName(frame, layerName);
            if (targetLayer && 'fills' in targetLayer) {
              const target = targetLayer as GeometryMixin & SceneNode;
              target.fills = [
                { type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }
              ];

              // Save URL to Instance/Frame PluginData using a JSON object
              if (imageUrl) {
                const existingJson = frame.getPluginData('img_urls');
                let urlMap: Record<string, string> = {};
                try {
                  if (existingJson) urlMap = JSON.parse(existingJson);
                } catch { }

                urlMap[layerName] = imageUrl;
                frame.setPluginData('img_urls', JSON.stringify(urlMap));
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('圖片嵌入失敗:', e);
    }
    return;
  }

  // ================================================================
  // 獲取現有圖片 URL (用於優化同步)
  // ================================================================
  if (msg.type === 'get-image-urls') {
    try {
      const { notionIds } = msg;
      const existingMap = buildExistingMap();
      const resultMap: Record<string, Record<string, string>> = {};

      for (const id of notionIds) {
        const nodes = existingMap.get(id); // 现在返回数组
        // 取第一个节点的图片 URL（所有相同 ID 的 instance 应该有相同的图片）
        if (nodes && nodes.length > 0) {
          const json = nodes[0].getPluginData('img_urls');
          if (json) {
            try {
              resultMap[id] = JSON.parse(json);
            } catch { }
          }
        }
      }
      figma.ui.postMessage({ type: 'image-urls', urls: resultMap });
    } catch (e) {
      console.warn(e);
      figma.ui.postMessage({ type: 'image-urls', urls: {} });
    }
    return;
  }

  // ================================================================
  // 工具：读取选中 Instance 的 ID
  // ================================================================
  if (msg.type === 'read-instance-id') {
    try {
      const selection = figma.currentPage.selection;

      if (selection.length === 0) {
        figma.ui.postMessage({ type: 'error', message: '请先选中一个 Instance' });
        return;
      }

      const node = selection[0];
      const notionId = node.getPluginData(PLUGIN_DATA_KEY);

      if (!notionId) {
        figma.ui.postMessage({ type: 'error', message: '该节点没有 Notion ID（可能不是由插件创建的）' });
        return;
      }

      figma.ui.postMessage({
        type: 'instance-id-info',
        currentId: notionId,
        nodeName: node.name
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      figma.ui.postMessage({ type: 'error', message: `读取失败: ${errorMsg}` });
    }
    return;
  }

  // ================================================================
  // 工具：更新选中 Instance 的 ID
  // ================================================================
  if (msg.type === 'update-instance-id') {
    try {
      const { newId } = msg;
      const selection = figma.currentPage.selection;

      if (selection.length === 0) {
        figma.ui.postMessage({ type: 'error', message: '请先选中一个 Instance' });
        return;
      }

      if (!newId || newId.trim() === '') {
        figma.ui.postMessage({ type: 'error', message: '请输入有效的 ID' });
        return;
      }

      const node = selection[0];
      const oldId = node.getPluginData(PLUGIN_DATA_KEY);
      node.setPluginData(PLUGIN_DATA_KEY, newId.trim());

      figma.ui.postMessage({
        type: 'id-updated',
        message: `ID 已更新: ${oldId || '(无)'} → ${newId.trim()}`
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      figma.ui.postMessage({ type: 'error', message: `更新失败: ${errorMsg}` });
    }
    return;
  }

  // ================================================================
  // 工具：恢复上次选择的 Component
  // ================================================================
  if (msg.type === 'restore-component') {
    try {
      const { componentId } = msg;
      const node = await figma.getNodeByIdAsync(componentId);

      if (!node || (node.type !== 'COMPONENT' && node.type !== 'FRAME' && node.type !== 'GROUP' && node.type !== 'COMPONENT_SET')) {
        figma.ui.postMessage({
          type: 'error',
          message: 'Template 節點不存在或類型不符'
        });
        return;
      }

      // If it's a ComponentSet, we use the first child as the visual template for layer discovery
      const templateNode = node.type === 'COMPONENT_SET' ? (node as ComponentSetNode).children[0] : node;
      const layers = collectLayers(templateNode as SceneNode);

      figma.ui.postMessage({
        type: 'component-data',
        componentName: node.name,
        componentId: node.id,
        layers: layers
      });
    } catch (e) {
      console.warn('[恢复失败]', e);
      figma.ui.postMessage({
        type: 'error',
        message: 'Component 恢复失败'
      });
    }
    return;
  }

  // ================================================================
  // 工具：从选中的 Instance 加载配置
  // ================================================================
  if (msg.type === 'load-from-selection') {
    try {
      const selected = figma.currentPage.selection;

      if (selected.length === 0) {
        figma.ui.postMessage({
          type: 'error',
          message: '请先选中一个 Instance'
        });
        return;
      }

      const node = selected[0];
      let template: SceneNode | null = null;
      let mappingId: string = '';

      if (node.type === 'INSTANCE') {
        template = await (node as InstanceNode).getMainComponentAsync();
        mappingId = template ? getMappingId(template) : '';
      } else if (node.type === 'FRAME' || node.type === 'GROUP') {
        // [New] Check if it has recovery ID
        const recoveredId = node.getPluginData(PLUGIN_DATA_COMPONENT);
        if (recoveredId) {
          console.log('[從選取加載] 發現恢復 ID:', recoveredId);
          const recoveredNode = await figma.getNodeByIdAsync(recoveredId);
          if (recoveredNode) {
            template = recoveredNode as SceneNode;
            mappingId = recoveredNode.type === 'COMPONENT' ? getMappingId(recoveredNode) : recoveredId;
          }
        }

        // Fallback to itself
        if (!template) {
          template = node;
          mappingId = node.id;
        }
      }

      if (!template || !mappingId) {
        figma.ui.postMessage({
          type: 'error',
          message: '無法從選取項找到有效的 Template (請選擇 Instance, Frame 或 Group)'
        });
        return;
      }

      console.log('[從選取加載] Template:', template.name, 'Mapping ID:', mappingId);

      // 讀取 Template 的圖層信息
      const layers = collectLayers(template);

      figma.ui.postMessage({
        type: 'component-data',
        componentName: template.name,
        componentId: mappingId,
        actualTemplateId: template.id, // [New] Pass back the specific node ID
        layers: layers,
        fromSelection: true
      });
    } catch (e) {
      console.warn('[从选中加载失败]', e);
      figma.ui.postMessage({
        type: 'error',
        message: '加载失败，请重试'
      });
    }
    return;
  }

  // ================================================================
  // 工具：同步选中的 Instance
  // ================================================================
  if (msg.type === 'sync-selected') {
    try {
      const { componentId, mappings, idField, notionData } = msg;
      const selection = figma.currentPage.selection;

      if (selection.length === 0) {
        figma.ui.postMessage({ type: 'error', message: '請先選取至少一個物件' });
        return;
      }

      // 过滤出有 notionId 的节点
      const nodesWithId = selection.filter(node => node.getPluginData(PLUGIN_DATA_KEY));

      if (nodesWithId.length === 0) {
        figma.ui.postMessage({ type: 'error', message: '選中的物件中沒有可同步的數據 (Notion ID)' });
        return;
      }

      // 获取所有需要同步的 notionIds
      console.log(`找到 ${nodesWithId.length} 個選中的物件有 ID 數據`);

      // 验证 template 存在
      const templateNode = await figma.getNodeByIdAsync(componentId) as SceneNode | null;
      if (!templateNode) {
        figma.ui.postMessage({ type: 'error', message: 'Template 不存在' });
        return;
      }
      if ('children' in templateNode) {
        await loadAllFontsFromComponent(templateNode as any);
      }

      // 更新每個選中的物件
      let updatedCount = 0;
      const updatedNotionIds: string[] = [];

      for (const node of nodesWithId) {
        const notionId = node.getPluginData(PLUGIN_DATA_KEY);
        // 从数据中找到对应记录
        const record = notionData.find((item: any) => {
          return String(item[idField] || '') === notionId;
        });

        if (record) {
          await updateInstance(node, record, mappings);
          updatedCount++;
          updatedNotionIds.push(notionId);
        } else {
          console.warn(`未找到 ID ${notionId} 对应的数据记录`);
        }
      }

      figma.ui.postMessage({
        type: 'sync-selected-done',
        message: `已更新 ${updatedCount}/${nodesWithId.length} 個物件`,
        updatedCount: updatedCount,
        updatedNotionIds: updatedNotionIds,  // 返回更新的IDs
        totalCount: nodesWithId.length
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      figma.ui.postMessage({ type: 'error', message: `同步失败: ${errorMsg}` });
    }
    return;
  }

  // ================================================================
  // Step 4：根據映射規則同步數據
  // ================================================================
  if (msg.type === 'sync-mapped-data') {
    console.log('收到 sync-mapped-data 請求');
    try {
      const { componentId, templateId, data, mappings, idField } = msg;
      console.log('Mapping ID:', componentId, 'Template ID:', templateId);

      if (!data || !Array.isArray(data) || data.length === 0) {
        figma.ui.postMessage({ type: 'error', message: '未收到有效數據' });
        return;
      }

      if (!mappings || mappings.length === 0) {
        figma.ui.postMessage({ type: 'error', message: '未設定任何映射規則' });
        return;
      }

      // 1. 找到來源 Template
      // if templateId exists, use it. Otherwise fallback to componentId
      const targetSourceId = templateId || componentId;
      const templateNode = await figma.getNodeByIdAsync(targetSourceId) as SceneNode | null;
      if (!templateNode) {
        console.error('找不到 Template ID:', targetSourceId);
        figma.ui.postMessage({ type: 'error', message: '找不到來源 Template，可能已刪除' });
        return;
      }

      sendStatus(`收到 ${data.length} 條數據，正在加載字型...`);

      // 2. 預加載所有需要的字型
      if ('children' in templateNode) {
        await loadAllFontsFromComponent(templateNode as any);
      }

      // 3. 建立已有 Instance 索引 (notionId → SceneNode)
      sendStatus('正在掃描畫布上的現有 Instance...');
      const existingMap = buildExistingMap();
      const existingCount = existingMap.size;
      sendStatus(`找到 ${existingCount} 個現有 Instance，開始同步...`);

      // 4. 計算新 Instance 的起始位置
      let newIndex = 0;
      const startY = getNextAvailableY();
      const cardWidth = 'width' in templateNode ? (templateNode as any).width : 100;
      const cardHeight = 'height' in templateNode ? (templateNode as any).height : 100;

      // 5. 處理所有映射 (Text & Visibility)
      // 圖片內容由 UI 後續通過 set-image 處理，但可見性在此處理

      let updatedCount = 0;
      let createdCount = 0;
      const affectedNodes: SceneNode[] = [];

      for (let i = 0; i < data.length; i++) {
        const record = data[i];
        const recordId = String(record[idField] || `row-${i}`);
        const existingNodes = existingMap.get(recordId); // 现在返回数组

        if (existingNodes && existingNodes.length > 0) {
          // ---- UPDATE: 更新所有使用此 ID 的 Instance（支持多个 instance 使用相同 ID）----
          for (const existingNode of existingNodes) {
            await updateInstance(existingNode, record, mappings);
            updatedCount++;
            affectedNodes.push(existingNode);
          }
        } else {
          // ---- INSERT: 建立新 Instance ----
          const col = newIndex % CARDS_PER_ROW;
          const row = Math.floor(newIndex / CARDS_PER_ROW);
          const x = col * (cardWidth + CARD_GAP);
          const y = startY + row * (cardHeight + CARD_GAP);

          let instance: SceneNode;
          if (templateNode.type === 'COMPONENT') {
            instance = (templateNode as ComponentNode).createInstance();
          } else {
            instance = templateNode.clone() as SceneNode;
          }

          // 強制放到當前 Page 的根目錄，避免被 Template 的父層級影響位置
          figma.currentPage.appendChild(instance);
          instance.x = x;
          instance.y = y;
          instance.setPluginData(PLUGIN_DATA_KEY, recordId);
          instance.setPluginData(PLUGIN_DATA_COMPONENT, componentId);

          // 填充數據
          await fillInstanceData(instance as InstanceNode | FrameNode | GroupNode, record, mappings);

          createdCount++;
          newIndex++;
          affectedNodes.push(instance);
        }

        sendStatus(`同步進度: ${i + 1}/${data.length}`);
      }

      // 7. 聚焦到生成的內容
      if (affectedNodes.length > 0) {
        figma.viewport.scrollAndZoomIntoView(affectedNodes);
      }

      // 6. 完成
      figma.ui.postMessage({
        type: 'done',
        message: `同步完成！新增 ${createdCount} 個、更新 ${updatedCount} 個 Instance`
      });

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({ type: 'error', message: `同步失敗: ${errorMessage}` });
    }
  }
  // ================================================================
  // Storage Handlers (Phase 2)
  // ================================================================
  if (msg.type === 'storage-get') {
    try {
      const value = await figma.clientStorage.getAsync(msg.key);
      figma.ui.postMessage({ type: 'storage-data', key: msg.key, value });
    } catch (e) {
      console.warn('Storage Get Error:', e);
      figma.ui.postMessage({ type: 'storage-data', key: msg.key, value: null });
    }
    return;
  }

  if (msg.type === 'storage-set') {
    try {
      await figma.clientStorage.setAsync(msg.key, msg.value);
    } catch (e) {
      console.warn('Storage Set Error:', e);
    }
    return;
  }
};

// ====================================================================
// 工具函數
// ====================================================================

function sendStatus(message: string) {
  figma.ui.postMessage({ type: 'status', message });
}

/** 獲取用於儲存映射配置的 ID (如果是 Variant 則返還 ComponentSet ID) */
function getMappingId(node: SceneNode): string {
  let target = node;

  // 1. 如果是 Instance，先找其 Master Component
  if (target.type === 'INSTANCE') {
    const mainComp = (target as InstanceNode).mainComponent;
    if (mainComp) target = mainComp;
  }

  // 2. 如果是 Component 且屬於 ComponentSet (Variant)，返還 Set ID
  if (target.type === 'COMPONENT') {
    const comp = target as ComponentNode;
    if (comp.parent && comp.parent.type === 'COMPONENT_SET') {
      return comp.parent.id;
    }
  }

  return target.id;
}

/** 遞歸收集 Component 中所有可映射的圖層 */
function collectLayers(node: SceneNode, prefix = ''): { name: string; type: string; path: string }[] {
  const results: { name: string; type: string; path: string }[] = [];
  const fullPath = prefix ? `${prefix}/${node.name}` : node.name;

  // 只收集帶有 # 的圖層 (Text, Image, or Visibility Candidates)
  if (node.name.includes('#')) {
    // 允許任何類型的圖層 (Group, Frame, Text, Vector, etc.)
    // 用於文字填充、圖片填充、或 Boolean 可見性控制
    results.push({ name: node.name, type: node.type, path: fullPath });
  }

  // 遞歸進入子圖層
  if ('children' in node) {
    // Safe cast: checking 'children' property existence first
    for (const child of (node as FrameNode).children) {
      results.push(...collectLayers(child, fullPath));
    }
  }

  return results;
}

/** 掃描當前頁面，建立 notionId → SceneNode[] 索引（支持多个 instance 使用相同 ID） */
function buildExistingMap(): Map<string, SceneNode[]> {
  const map = new Map<string, SceneNode[]>();
  const page = figma.currentPage;

  function walk(node: SceneNode) {
    const notionId = node.getPluginData(PLUGIN_DATA_KEY);
    if (notionId) {
      // 支持多个 instance 使用相同的 ID
      const existing = map.get(notionId) || [];
      existing.push(node);
      map.set(notionId, existing);
    }
    if ('children' in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  for (const child of page.children) {
    walk(child);
  }
  return map;
}

/** 取得畫布上所有節點的最底部 Y 座標 */
function getNextAvailableY(): number {
  let maxY = 0;
  for (const child of figma.currentPage.children) {
    const bottom = child.y + child.height;
    if (bottom > maxY) {
      maxY = bottom;
    }
  }
  return maxY > 0 ? maxY + CARD_GAP * 2 : 0;
}

/** 在 Frame / Instance 中遞歸查找指定名稱的子節點 */
function findChildByName(parent: FrameNode | GroupNode | InstanceNode, name: string): SceneNode | null {
  for (const child of parent.children) {
    if (child.name === name) return child;
    if ('children' in child) {
      const found = findChildByName(child as FrameNode, name);
      if (found) return found;
    }
  }
  return null;
}

/** 預加載 Template 中所有 TextNode 使用的字型 */
async function loadAllFontsFromComponent(template: SceneNode) {
  const textNodes: TextNode[] = [];

  function collectTextNodes(node: SceneNode) {
    if (node.type === 'TEXT') {
      textNodes.push(node as TextNode);
    }
    if ('children' in node) {
      for (const child of (node as any).children) {
        collectTextNodes(child);
      }
    }
  }

  collectTextNodes(template);

  for (const textNode of textNodes) {
    const fontName = textNode.fontName;
    if (fontName !== figma.mixed) {
      try {
        await figma.loadFontAsync(fontName);
      } catch (e) {
        console.warn(`無法載入字型 ${fontName.family} ${fontName.style}:`, e);
      }
    }
  }
}

// ====================================================================
// Instance 數據填充
// ====================================================================

/** 偵測並套用 Figma 原生清單樣式 (如 1. 2. 3.) */
async function parseAndApplyListStyle(textNode: TextNode, rawValue: string) {
  const lines = rawValue.split('\n');
  const numberedPattern = /^\d+\.\s+/;

  // 檢查是否符合數字清單特徵 (至少第一行係以 1. 開頭)
  const isNumberedList = numberedPattern.test(lines[0]);

  if (isNumberedList) {
    // 清除手動輸入嘅 "1. ", "2. " 前綴，由 Figma 自動生成
    const cleanedLines = lines.map(line => line.replace(numberedPattern, ''));
    const cleanedText = cleanedLines.join('\n');

    textNode.characters = cleanedText;
    // 套用 ORDERED (數字) 清單樣式到全段文字
    textNode.setRangeListOptions(0, cleanedText.length, { type: 'ORDERED' });
  } else {
    // 普通文字，確保清單樣式係 NONE
    textNode.characters = rawValue;
    textNode.setRangeListOptions(0, rawValue.length, { type: 'NONE' });
  }
}

/** 將各種輸入轉換為 Boolean (支援 Yes/No, True/False, 1/0, Checked/Unchecked) */
function parseBoolean(val: any): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const s = val.toLowerCase().trim();
    if (s === 'true' || s === 'yes' || s === '1' || s === 'checked' || s === 'ok') return true;
    if (s === 'false' || s === 'no' || s === '0' || s === 'unchecked' || s === '' || s === 'null') return false;
    // 如果是普通文字且不為空，可視為 true (或者根據需求調整)
    return s.length > 0;
  }
  return !!val;
}

/** 填充 Instance / Frame / Group 的數據 (Text & Visibility) */
async function fillInstanceData(
  instance: InstanceNode | FrameNode | GroupNode,
  record: Record<string, any>,
  mappings: FieldMapping[]
) {
  for (const mapping of mappings) {
    const targetNode = findChildByName(instance, mapping.layerName);
    if (!targetNode) continue;

    const value = record[mapping.dataField];
    if (value === undefined || value === null) continue;

    // 1. 如果數據是明確的布林意圖，或者圖層類型不是 TEXT，則優先處理可見性
    // 注意：如果用戶把同一個欄位 mapping 到 TEXT 圖層，我們通常希望既控制隱藏也顯示文字
    const isVisible = parseBoolean(value);
    targetNode.visible = isVisible;

    // 2. 如果圖層是隱藏的，就不需要更新文字了 (節省效能)
    if (!isVisible) continue;

    // 3. Text Content (僅當它是 TEXT 節點且 value 不是單純的布林值時更新)
    if (targetNode.type === 'TEXT') {
      // 如果 value 是 boolean，我們不希望把 "true" 字樣寫進去，除非它是唯一的內容
      if (typeof value === 'boolean') continue;

      const textNode = targetNode as TextNode;
      const fontName = textNode.fontName;
      if (fontName !== figma.mixed) {
        await figma.loadFontAsync(fontName);
      }

      // 使用清單樣式處理邏輯
      await parseAndApplyListStyle(textNode, String(value));
    }
  }
}

/** 更新現有 Instance / Frame（保留位置） */
async function updateInstance(
  node: SceneNode,
  record: Record<string, any>,
  mappings: FieldMapping[]
) {
  if (!('children' in node)) return;
  // 此處我們允許 InstanceNode, FrameNode 或 GroupNode
  const container = node as InstanceNode | FrameNode | GroupNode;
  await fillInstanceData(container, record, mappings);
}
