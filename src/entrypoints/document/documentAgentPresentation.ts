/**
 * 「翻译 Agent」面板的展示逻辑。
 *
 * 组件只负责渲染，文案与状态判定放在这里，便于单测覆盖：
 * 面板最容易出问题的地方不是排版，而是「用户还没开始就被告知失败/继续/待处理」。
 */

/** 面板主卡片的三态；`resuming` 表示已经翻过一部分。 */
export type AgentProgressPhase = 'idle' | 'running' | 'resuming' | 'complete';

export interface AgentProgressCopy {
  phase: AgentProgressPhase;
  kicker: string;
  title: string;
  description: string;
  /** 主按钮文案；`complete` 态为空，此时不渲染主按钮。 */
  actionLabel: string;
  /** 从未开始时不显示 0% 和空进度条——没有进度比「0%」更清楚。 */
  showProgress: boolean;
  percentLabel: string;
}

export interface AgentProgressInput {
  isRunning: boolean;
  acceptedSegments: number;
  totalSegments: number;
  pendingSegments: number;
}

function count(value: number): string {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('zh-CN');
}

/**
 * 决定主卡片的文案。
 *
 * 关键约束：`acceptedSegments === 0` 是「从未开始」，不是「等待继续」。
 * 之前把两者合并成「继续完成这份文档」，用户打开页面就被告知在续做一件没做过的事。
 */
export function agentProgressCopy(input: AgentProgressInput): AgentProgressCopy {
  const total = Math.max(0, Number(input.totalSegments) || 0);
  const pending = Math.max(0, Number(input.pendingSegments) || 0);
  const accepted = Math.max(0, Number(input.acceptedSegments) || 0);

  if (input.isRunning) {
    return {
      phase: 'running',
      kicker: '正在处理',
      title: '正在翻译这本书',
      description: '译文会自动保存，关掉页面也不会丢进度。',
      actionLabel: '正在翻译…',
      showProgress: true,
      percentLabel: '本次任务',
    };
  }
  if (pending === 0) {
    return {
      phase: 'complete',
      kicker: '已完成',
      title: '这本书已经翻译完',
      description: '可以回到阅读页查看。需要重做时，用下面的“更多选项”。',
      actionLabel: '',
      showProgress: true,
      percentLabel: '全书完成度',
    };
  }
  if (accepted === 0) {
    return {
      phase: 'idle',
      kicker: '尚未开始',
      title: '还没有开始翻译',
      description: '全书共 ' + count(total) + ' 段。开始后会自动翻译、审校并保存进度。',
      actionLabel: '开始翻译',
      showProgress: false,
      percentLabel: '',
    };
  }
  return {
    phase: 'resuming',
    kicker: '进行中',
    title: '还有 ' + count(pending) + ' 段没翻完',
    description: '继续只会处理未完成和原文已变的段落，已确认的译文不会被改动。',
    actionLabel: '继续翻译',
    showProgress: true,
    percentLabel: '全书完成度',
  };
}

/** 自动保存只对可结算的终态 Run 有意义。 */
export function canAutoAcceptRun(run: Record<string, any> | null | undefined): boolean {
  if (!run) return false;
  if (Number(run.counts?.candidate || 0) <= 0) return false;
  // failed / paused 的 Run 里往往还留着 pending 片段，服务端会以 409 拒绝结算；
  // 那种情况下正确动作是「恢复运行」，不是「重试保存」。
  return ['awaiting_acceptance', 'partial', 'completed'].includes(String(run.status || ''));
}

/** 质量修复子 Run 由服务端自动调度，不应成为用户打开面板时看到的主 Run。 */
export function isAutomationRun(run: Record<string, any> | null | undefined): boolean {
  return String(run?.scope?.automation?.kind || '') === 'quality-audit-repair';
}

/**
 * 打开面板时选中哪个 Run。
 *
 * 优先正在跑的；其次最近一次人工 Run；最后才回退到自动修复子 Run。
 * 之前直接取 `runs[0]`，于是服务重启时被中断的自动修复子 Run 会顶到最前面，
 * 用户一打开就看到「失败」和一句看不懂的采纳错误。
 */
export function pickInitialRun(runs: unknown): Record<string, any> | null {
  const list = Array.isArray(runs) ? runs.filter((run) => run && typeof run === 'object') as Array<Record<string, any>> : [];
  if (!list.length) return null;
  const live = list.find((run) => ['queued', 'running'].includes(String(run.status || '')));
  if (live) return live;
  const manual = list.find((run) => !isAutomationRun(run));
  return manual || list[0] || null;
}

const ERROR_COPY: Array<[RegExp, string]> = [
  [/拒绝结束采纳事务|待处理或执行中的片段/, '还有段落没翻完，这批结果暂时不能保存。先恢复运行，再保存。'],
  [/服务重启中断了这次运行/, '本机服务重启，这次运行被中断了。'],
  [/模型未返回完整的片段集合/, '模型这次返回的片段不全，已自动重试过，仍有片段没拿到译文。'],
  [/Workbuddy 调用超时|调用超时/, '模型调用超时，可以重试这一段。'],
];

/** 把服务端的内部措辞换成人话；未知错误原样保留，避免掩盖真实原因。 */
export function humanizeAgentError(message: unknown): string {
  const text = String(message || '').trim();
  if (!text) return '';
  for (const [pattern, copy] of ERROR_COPY) {
    if (pattern.test(text)) return copy;
  }
  return text;
}
