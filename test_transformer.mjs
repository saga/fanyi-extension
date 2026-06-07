// 强行拦截并伪造一个全局模块，让 transformers 以为 sharp 已经存在
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
try {
    // 动态模拟 sharp 导出，欺骗底层的动态 import
    process.env.NODE_SHARP_SKIP_DETECTION = '1'; 
} catch (e) {}

import { pipeline, env } from '@huggingface/transformers';

// 禁用所有纯 Node 端的图片/音频等重量级后端
env.allowLocalModels = false;

env.backends.onnx.wasm.numThreads = 1;

// Allocate a pipeline for sentiment-analysis
const pipe = await pipeline('feature-extraction', 'Xenova/TinyBERT_General_4L_312D', {
    dtype: 'q4' // 配合 4-bit 量化，体积只有 10几兆
});

const out = await pipe('I love transformers!');
// [{'label': 'POSITIVE', 'score': 0.999817686}]


