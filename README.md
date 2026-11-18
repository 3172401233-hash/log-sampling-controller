# log-sampling-controller

JavaScript 日志采样控制库，处理错误保留、噪声预算、服务公平和动态采样率。

## 用法

```js
const { LogSampler } = require('./src/sampler');

const sampler = new LogSampler({
  windowMs: 1000,        // 时间窗口长度（毫秒）
  serviceBudget: 100,    // 每服务每窗口最多保留条数
  globalBudget: 1000,    // 全局每窗口最多保留条数
});

const decision = sampler.decide({
  serviceId: 'payment-api',
  level: 'ERROR',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  message: 'charge failed for order 12345',
});
// => { keep: true, reason: 'first-error', sampleRate: 1 }
```

`decide()` 返回：

- `keep`：保留（`true`）或丢弃（`false`）。
- `reason`：触发原因，见下表。
- `sampleRate`：该服务当前窗口的自适应采样率（0–1）。

`stats()` 返回当前窗口的全局与每服务统计：到达数、保留数、丢弃数、实际采样率（`kept / arrivals`）以及按原因分类的计数。`setBudgets({ serviceBudget, globalBudget })` 可在窗口中途调整预算，立即生效。

## 决策优先级

1. **trace 缓存**：同一 `traceId` 的首条日志做出决策后，缓存期内该 trace 的所有后续日志沿用同一决策（`trace-consistent`），保证链路完整。
2. **错误提权**：`ERROR`/`FATAL` 按 `errorKeepProbability` 保留；首次出现的错误指纹（服务 + 级别 + 归一化消息）按 `firstErrorKeepProbability` 保留（`first-error` / `error`）。错误不受预算硬顶限制。
3. **重复降采样**：同一指纹在同一窗口内重复出现时，每 `duplicateKeepEvery` 条保留 1 条（`duplicate`）。消息中的数字和 UUID 会归一化，因此 "user 12 failed" 与 "user 34 failed" 视为同一重复日志。
4. **自适应速率 + 预算硬顶**：普通日志按 `serviceBudget / 窗口预计到达量` 的动态速率采样（`sampled` / `rate-limited`）；有 `traceId` 时通过对 traceId 哈希采样，保证同一速率下决策确定。每服务预算或全局预算耗尽后直接丢弃（`service-budget-exhausted` / `global-budget-exhausted`）。每服务预算使高噪声服务无法挤占低流量服务的配额。

## 有偏采样说明

保留下来的日志**不是**原始流量的无偏代表：

- 错误被系统性高估：错误日志以更高概率保留，且错误所在 trace 的上下游日志会被一并保留，因此保留样本中的错误比例高于真实比例。估算真实错误率时必须按 `sampleRate` 加权还原。
- 重复日志的量被低估：相同指纹的日志只保留 1/N，保留样本无法反映重复风暴的真实规模（可结合 `stats()` 中的 `arrivals` 还原）。
- 按 trace 一致性采样：被保留的 trace 是完整的，但被丢弃的 trace 整体缺失，无法从样本中估计"有多少不同的 trace"。
- 低流量服务几乎全保留、高噪声服务被大幅抽稀，跨服务直接比较保留量没有意义。

## 无法保证完整性的部分

- **预算硬顶会丢数据**：窗口内非错误日志超过预算后会被丢弃，突发期间必然丢失部分日志。
- **错误可能超出预算**：错误日志绕过预算硬顶，错误风暴时实际保留量会超过 `serviceBudget` / `globalBudget`，预算只是软目标。
- **trace 一致性优先于预算**：命中 trace 缓存的保留决策不再检查预算，长链路 trace 可能使保留量超限。
- **trace 缓存有 TTL**：超过 `traceTtlMs`（默认 10 个窗口）后缓存过期，跨度过长的 trace 前后决策可能不一致。
- **状态不持久**：trace 缓存、错误指纹、窗口计数都在内存中，进程重启后"首次错误"会再次被视为首次，trace 决策也可能翻转。
- **采样率基于窗口内投影**：窗口前 5% 时间内按保守投影估算，突发形状与投影不符时，实际保留量会偏离预算。
- **时钟回拨**：窗口按注入时钟划分，时钟回拨不会触发窗口重置，可能导致预算超用。

## 测试

```sh
npm test   # 即 node --test
```

覆盖突发噪声、错误链路、重复日志、服务公平、全局预算、预算动态调整和时钟窗口滚动。测试通过注入 `now` 时钟和固定 traceId 实现确定性。
