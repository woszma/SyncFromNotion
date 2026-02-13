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

// --- 主程式 ---
figma.showUI(__html__, { width: 420, height: 520 });

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
      }

      if (!component) {
        console.error('選擇的節點不是 Component:', selected.type);
        figma.ui.postMessage({
          type: 'error',
          message: `選擇的是 ${selected.type}，請選擇 Component 或 Instance。`
        });
        return;
      }

      console.log('找到 Component:', component.name, component.id);
      const layers = collectLayers(component);
      console.log('收集到圖層數量:', layers.length);

      figma.ui.postMessage({
        type: 'component-layers',
        componentId: component.id,
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
      const { notionId, layerName, imageBytes } = msg;
      if (!notionId || !imageBytes || !layerName) return;

      const existingMap = buildExistingMap();
      const node = existingMap.get(notionId);
      if (node && 'children' in node) {
        const frame = node as FrameNode;
        const imageData = new Uint8Array(imageBytes);
        const image = figma.createImage(imageData);

        const targetLayer = findChildByName(frame, layerName);
        if (targetLayer && 'fills' in targetLayer) {
          (targetLayer as GeometryMixin & SceneNode).fills = [
            { type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }
          ];
        }
      }
    } catch (e) {
      console.warn('圖片嵌入失敗:', e);
    }
    return;
  }

  // ================================================================
  // Step 4：根據映射規則同步數據
  // ================================================================
  if (msg.type === 'sync-mapped-data') {
    console.log('收到 sync-mapped-data 請求');
    try {
      const { componentId, data, mappings, idField } = msg as SyncRequest;
      console.log('Component ID:', componentId);
      console.log('Data Length:', data ? data.length : 0);
      console.log('Mappings:', mappings);

      if (!data || !Array.isArray(data) || data.length === 0) {
        figma.ui.postMessage({ type: 'error', message: '未收到有效數據' });
        return;
      }

      if (!mappings || mappings.length === 0) {
        figma.ui.postMessage({ type: 'error', message: '未設定任何映射規則' });
        return;
      }

      // 1. 找到來源 Component
      const component = await figma.getNodeByIdAsync(componentId) as ComponentNode | null;
      if (!component) {
        console.error('找不到 Component ID:', componentId);
        figma.ui.postMessage({ type: 'error', message: '找不到來源 Component，可能已刪除' });
        return;
      }
      if (component.type !== 'COMPONENT') {
        console.error('ID 對應的不是 Component:', component.type);
        figma.ui.postMessage({ type: 'error', message: '目標不是 Component' });
        return;
      }

      sendStatus(`收到 ${data.length} 條數據，正在加載字型...`);

      // 2. 預加載所有需要的字型
      await loadAllFontsFromComponent(component);

      // 3. 建立已有 Instance 索引 (notionId → SceneNode)
      sendStatus('正在掃描畫布上的現有 Instance...');
      const existingMap = buildExistingMap();
      const existingCount = existingMap.size;
      sendStatus(`找到 ${existingCount} 個現有 Instance，開始同步...`);

      // 4. 計算新 Instance 的起始位置
      let newIndex = 0;
      const startY = getNextAvailableY();
      const cardWidth = component.width;
      const cardHeight = component.height;

      // 5. 處理所有映射 (Text & Visibility)
      // 圖片內容由 UI 後續通過 set-image 處理，但可見性在此處理
      
      let updatedCount = 0;
      let createdCount = 0;
      const affectedNodes: SceneNode[] = [];

      for (let i = 0; i < data.length; i++) {
        const record = data[i];
        const recordId = String(record[idField] || `row-${i}`);
        const existingNode = existingMap.get(recordId);

        if (existingNode) {
          // ---- UPDATE: 更新現有 Instance（保留位置）----
          await updateInstance(existingNode, record, mappings);
          updatedCount++;
          affectedNodes.push(existingNode);
        } else {
          // ---- INSERT: 建立新 Instance ----
          const col = newIndex % CARDS_PER_ROW;
          const row = Math.floor(newIndex / CARDS_PER_ROW);
          const x = col * (cardWidth + CARD_GAP);
          const y = startY + row * (cardHeight + CARD_GAP);

          const instance = component.createInstance();
          // 強制放到當前 Page 的根目錄，避免被 Component 的父層級影響位置
          figma.currentPage.appendChild(instance);
          instance.x = x;
          instance.y = y;
          instance.setPluginData(PLUGIN_DATA_KEY, recordId);
          instance.setPluginData(PLUGIN_DATA_COMPONENT, componentId);

          // 填充數據
          await fillInstanceData(instance, record, mappings);

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

/** 遞歸收集 Component 中所有可映射的圖層 */
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

/** 掃描當前頁面，建立 notionId → SceneNode 索引 */
function buildExistingMap(): Map<string, SceneNode> {
  const map = new Map<string, SceneNode>();
  const page = figma.currentPage;

  function walk(node: SceneNode) {
    const notionId = node.getPluginData(PLUGIN_DATA_KEY);
    if (notionId) {
      map.set(notionId, node);
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

/** 預加載 Component 中所有 TextNode 使用的字型 */
async function loadAllFontsFromComponent(component: ComponentNode) {
  const textNodes: TextNode[] = [];

  function collectTextNodes(node: SceneNode) {
    if (node.type === 'TEXT') {
      textNodes.push(node as TextNode);
    }
    if ('children' in node) {
      for (const child of (node as FrameNode).children) {
        collectTextNodes(child);
      }
    }
  }

  collectTextNodes(component);

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

/** 填充 Instance / Frame 的數據 (Text & Visibility) */
async function fillInstanceData(
  instance: InstanceNode | FrameNode,
  record: Record<string, any>,
  mappings: FieldMapping[]
) {
  for (const mapping of mappings) {
    const targetNode = findChildByName(instance, mapping.layerName);
    if (!targetNode) continue;

    const value = record[mapping.dataField];
    if (value === undefined || value === null) continue;

    // 1. Boolean Coercion / Visibility Control
    if (typeof value === 'boolean') {
      targetNode.visible = value;
      continue; 
    }

    // 2. Text Content
    if (targetNode.type === 'TEXT') {
      const textNode = targetNode as TextNode;
      const fontName = textNode.fontName;
      if (fontName !== figma.mixed) {
        await figma.loadFontAsync(fontName);
      }
      textNode.characters = String(value);
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
  // 此處我們允許 InstanceNode 或 FrameNode (Detached Instance)
  const indatanceOrFrame = node as InstanceNode | FrameNode; 
  await fillInstanceData(indatanceOrFrame, record, mappings);
}
