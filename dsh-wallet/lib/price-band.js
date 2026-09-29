// 峰谷口径与法定节假日表 —— **唯一真源**（dsh-wallet host 半端与 scripts\token\dsh-usage-stats.mjs 共用）。
//
// 官方口径（api-docs 中文页「模型 & 价格」脚注 (2)）：空闲时段价格为高峰时段价格的一半；
// 北京时间**周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段**；
// 其余时段，包括周末及中国法定节假日全天，均为空闲时段。
//
// 节假日表真源：国务院办公厅 2026 年部分节假日安排（国办发明电〔2025〕7 号）。
// 落在周末的假日照录（逐日核对时不会漏）。**换年必须补表**，未收录年份退回「仅周末空闲」。

export const CN_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
]);

/** 北京日期串（en-CA 即 YYYY-MM-DD）。 */
export function shanghaiDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** 是否高峰时段（北京时间「周一至周五」9:00-12:00、14:00-18:00，法定节假日除外）。
 *  周末全天、法定节假日全天、调休上班的周末，均按空闲价计——漏判星期会让周六/周日全天被按
 *  2 倍高峰价计费（2026-09-12 实测：周六会话面板值恰为真值的 2.000 倍）；漏判节假日同理。 */
export function isPeakHour(now = new Date()) {
  try {
    if (CN_HOLIDAYS.has(shanghaiDate(now))) return false;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    if (Number.isNaN(hour)) return false;
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  } catch {
    return false;
  }
}
