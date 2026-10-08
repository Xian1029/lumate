# 首页受保护功能（Feature Regression Registry）

根路由 `/` 是学生个人学习首页。以下功能在任何首页重构中均不得移除、隐藏到二级菜单，或替换为仅展示状态。

| ID | 优先级 | 功能 | 明确入口 | 数据来源 | 主要动作 | 完成 / 恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| F-HOME-001 | P0 | 继续学习 | 今日继续学习卡片 | `GET /api/learning-plan-dashboard/overview` 的 `current_learning_action` | 进入当前 LearningTask 或服务端推荐内容 | Task 完成后服务端返回下一项；无任务时给出创建空间入口 |
| F-HOME-002 | P0 | 新建学习空间 | 页头“新建学习空间”；空间区“创建新的学习空间” | 固定导航入口 | 进入 `/new` | 上传 / 解析中可从首页资料处理中继续查看 |
| F-HOME-003 | P0 | 待确认学习计划 | 待确认计划卡片 | `pending_learning_plans`，仅 `LearningPlan.PENDING_APPROVAL` | 进入 `/learning-plans/:id/review` | 确认、调整、取消均有出口 |
| F-HOME-004 | P0 | 今日学习任务 | 今日任务区 | `today_tasks`（仅 ACTIVE Plan 的服务器排序结果） | 进入任务 `action_href`，失败回退至计划详情 | 完成 / 延后 / 重开由 LearningTask API 持久化 |
| F-HOME-005 | P1 | 我的学习空间 | 空间卡片区 | `learning_spaces` | 进入 `/course/:id` | 可随时从两处创建新空间 |
| F-HOME-006 | P1 | 资料处理中 | 资料处理中区 | `processing_uploads` | 返回上传与处理流程 | 失败可在上传页重新提交 |
| F-HOME-007 | P1 | 待复习 | 待复习区 | `review_queue`（LECTOR 后端聚合） | 进入 `/course/:id/review` | 完成复习后队列刷新 |
| F-HOME-008 | P2 | 最近学习 | 最近学习区 | `recent_learning` | 回到对应学习空间 | 无历史时不显示 |
| F-HOME-009 | P2 | 学习概况 | 学习概况区 | `learning_summary` | 仅摘要，无死链接 | 数据为空显示 0 但不抢占首次创建引导 |
| F-HOME-010 | P2 | 学习计划中心 | 页头“学习计划” | 固定导航入口 | 进入 `/learning-plans` | 可查看、确认、调整、暂停、恢复或取消计划 |

## 验收规则

每项功能必须同时具备：入口、执行、持久化、完成、恢复与下一步。P0 项必须在页面回归测试及组合场景测试中验证。
