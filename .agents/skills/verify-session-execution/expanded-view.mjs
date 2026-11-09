export const title='Session Inbox 多端投递与等待诊断';
const names={phase:'回复等待阶段',aborted:'已取消回调的后续写入',staleWrite:'发生迟到写入',body:'已同步正文',rpc:'已收到请求正文',receipt:'已收到用户凭据',activation:'已收到激活',latest:'最新激活',missing:'当前投递失败标记',failed:'已报告失败的输入',accepted:'已接纳',started:'已启动',finished:'已完成',active:'当前输入',badStart:'失败输入被再次启动',openFlag:'等待器标记打开',released:'真正放行写入',hook:'写入前回调',timer:'超时仍有效',disposed:'已结束',output:'输出已写入'};
export const state=v=>Object.entries(v).map(([k,value])=>`${names[k]??k} ${JSON.stringify(value)}`).join(' / ');
const labels={Body:'正文同步到执行机器',Rpc:'发送请求到达',Receipt:'用户凭据到达',Activation:'激活信息到达',Expire:'等待正文超时并报告失败',Accept:'接纳当前可见输入',Start:'开始执行输入',Finish:'完成当前输入',Done:'已结束或断网待恢复',ObserveHistory:'正文同步后开始写回复条目',Deadline:'超时后开始写回复条目',HookCompletes:'回复条目写入返回',Dispose:'结束旧输入',WriteOutput:'放行回复写入'};
export const step=action=>labels[action]??action;
