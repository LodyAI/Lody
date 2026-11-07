# Shiroi Markdown 渲染测试

## 基础语法

### 标题层级

# 一级标题

## 二级标题

### 三级标题

#### 四级标题

##### 五级标题

###### 六级标题

### 文本样式

这是**粗体文本**，这是*斜体文本*，这是***粗斜体***。

这是~~删除线~~文本。

这是 ==高亮标记== 文本。

这是 ++插入文本++ 效果。

这是 ||剧透文本，鼠标悬停显示|| 效果。

### 引用

> 这是一段引用文本可以有多行

### 分割线

---

---

---

---

## 列表

### 无序列表

- 项目一
- 子项目 1.1
- 子项目 1.2
- 子子项目
- 项目二
- 项目三

### 有序列表

1. 第一步
2. 第二步
3. 步骤 2.1
4. 步骤 2.2
5. 第三步

### GFM 任务列表

- [ ] 待办事项 1
- [x] 已完成事项 2
- [ ] 待办事项 3
- [x] 已完成事项 4

---

## 代码

### 行内代码

这是 `inline code` 行内代码示例。

使用 `npm install` 安装依赖。

### 代码块

```javascript
// JavaScript 代码高亮
function greet(name) {
  console.log(`Hello, ${name}!`);
  return {
    message: 'Welcome to Shiroi',
    timestamp: Date.now()
  };
}

greet('World');
```

```typescript
// TypeScript 代码高亮
interface User {
  id: number;
  name: string;
  email?: string;
}

const createUser = (data: Partial<User>): User => ({
  id: Date.now(),
  name: 'Anonymous',
  ...data
});
```

```python
# Python 代码高亮
def fibonacci(n: int) -> list[int]:
    """生成斐波那契数列"""
    if n <= 0:
        return []
    fib = [0, 1]
    for i in range(2, n):
        fib.append(fib[i-1] + fib[i-2])
    return fib[:n]

print(fibonacci(10))
```

```css
/* CSS 代码高亮 */
.container {
  display: flex;
  justify-content: center;
  align-items: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}
```

```bash
# Shell 命令
npm install
pnpm dev
docker compose up -d
```

```json
{
  "name": "shiroi",
  "version": "1.0.0",
  "dependencies": {
    "next": "^16.0.0",
    "react": "^19.0.0"
  }
}
```

---

## 表格

| 功能 | 支持情况 | 备注 |
| --- | --- | --- |
| Markdown 基础语法 | ✓ | 完全支持 |
| GFM 扩展 | ✓ | 任务列表、表格等 |
| 数学公式 | ✓ | KaTeX 渲染 |
| 代码高亮 | ✓ | Shiki 引擎 |
| 自定义组件 | ✓ | React 组件嵌入 |

| 左对齐 | 居中对齐 | 右对齐 |
| --- | --- | --- |
| 内容 | 内容 | 内容 |
| 较长的内容 | 较长的内容 | 较长的内容 |

---

## 数学公式 (KaTeX)

### 行内公式

爱因斯坦质能方程 $E = mc^2$ 是物理学中最著名的公式。

勾股定理表示为 $c = \pm\sqrt{a^2 + b^2}$ 。

二次方程求根公式是 $x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$ 。

也可以不带空格：勾股定理 $c = \pm\sqrt{a^2 + b^2}$ 和多项式 $P(x) = a_nx^n+a_{n-1}x^{n-1} + \dots + a_1x + a_0$ 。

### 块级公式









---

## 图片

### 基础图片

![](https://xcimg.szwego.com/img/f71fe4b2/22213165-6445-4d76-9238-3a61a5378d9a.jpg)

### 带标题的图片

![风景](https://xcimg.szwego.com/img/f71fe4b2/41a3e56f-97f1-4df4-bddd-4501ce3b8fed.jpg "这是一张风景图")

---

## 链接

### 普通链接

[访问 GitHub](https://github.com)

[Shiroi 项目](https://github.com/Innei/Shiro)

### 自动链接

[https://github.com/Innei](https://github.com/Innei)

[https://github.com/Innei/Shiro](https://github.com/Innei/Shiro)

---

## 富链接卡片 (自动解析)

### GitHub 仓库

[Innei/Shiro](https://github.com/Innei/Shiro)

### GitHub Commit

[vuejs/vitepress - Commit](https://github.com/vuejs/vitepress/commit/71eb11f72e60706a546b756dc3fd72d06e2ae4e2)

### GitHub PR

[Innei/Shiro - Pull Request #129](https://github.com/Innei/Shiro/pull/129)

### GitHub 文件预览

<https://github.com/Innei/Shiro/blob/108d4c3e927e1c9c9304e41a0631f91958477d9f/src/providers/root/modal-stack-provider.tsx>

### Twitter/X

<https://twitter.com/zhizijun/status/1649822091234148352>

### YouTube

<https://www.youtube.com/watch?v=N93cTbtLCIM>

### GitHub Gist

<https://gist.github.com/Innei/94b3e8f078d29e1820813a24a3d8b04e>

### CodeSandbox

<https://codesandbox.io/s/framer-motion-layoutroot-prop-forked-p39g96>

### 站内文章链接

如果链接指向本站的文章，会自动渲染为卡片形式：

[站内文章](https://www.lxink.cn/posts/share/seedflow)

---

## LinkCard 组件

[mx-space/core](https://github.com/mx-space/core)

[Innei/Shiro](https://github.com/Innei/Shiro)

[mx-space/kami - Commit](https://github.com/mx-space/kami/commit/e1eee4136c21ab03ab5690e17025777984c362a0)

---

## 更多 LinkCard 类型

### Arxiv 论文

[Arxiv Paper](https://arxiv.org/abs/2309.16889)

### Bangumi 番剧

[Bangumi Subject](https://bgm.tv/subject/424883)

### LeetCode 题目

[Two Sum - LeetCode](https://leetcode.cn/problems/two-sum)

### 网易云音乐

[网易云音乐](https://music.163.com/#/song?id=1901371647)

### QQ 音乐

[QQ 音乐](https://y.qq.com/n/ryqq/songDetail/003aAYrm3GE0Ac)

### Bilibili 视频

[Bilibili 视频](https://www.bilibili.com/video/BV1GJ411x7h7)

### TMDB 影视

[Fight Club - TMDB](https://www.themoviedb.org/movie/550-fight-club)

---

## @ 提及

[Innei]{GH@Innei}

[52Lxcloud]{TG@52Lxcloud}

支持的平台：

- GitHub: `{GH@用户名}`
- Twitter: `{TW@用户名}`
- Telegram: `{TG@用户名}`

---

## GitHub 风格 Alerts

> [!NOTE]
> 这是一条提示信息，用户在浏览内容时应该了解的有用信息。

> [!TIP]
> 这是一条小技巧，帮助用户更好或更轻松地完成任务。

> [!IMPORTANT]
> 这是重要信息，用户需要了解才能实现目标。

> [!WARNING]
> 这是警告信息，需要用户立即注意以避免问题。

> [!CAUTION]
> 这是危险提示，告知用户某些操作的风险或负面后果。

---

## Container 容器语法

### Banner 提示框

::: info

:::

::: success

:::

::: warning

:::

::: error

:::

> [!NOTE]
> 这是一条笔记/备注信息。

### 自定义 Banner

::: warning

:::

::: success

:::

---

## 图片画廊

![](https://xcimg.szwego.com/img/f71fe4b2/9bc5ff3c-4dfd-4023-90ca-bb8983e99b0f.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/59330e47-7605-473a-973b-3343b8179302.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/cd17eb14-bfad-4b52-9a1c-586738acc0c5.jpg)

---

## Grid 网格布局

### 普通网格

::: grid{cols=3 gap="8px"}

:::

### 图片网格

![](https://xcimg.szwego.com/img/f71fe4b2/2567d100-a7c8-43f1-b1b7-5c32d655ccd3.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/cd17eb14-bfad-4b52-9a1c-586738acc0c5.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/9bc5ff3c-4dfd-4023-90ca-bb8983e99b0f.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/9761a552-1e29-41ed-8826-5f5e264b4d56.jpg)

### 3x3 图片网格

![](https://xcimg.szwego.com/img/f71fe4b2/ea74bf29-a000-49d9-9f04-49383eaf0a7c.jpeg)
![](https://xcimg.szwego.com/img/f71fe4b2/51a974ab-1d20-4d79-8948-89ecbde2afcd.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/41a3e56f-97f1-4df4-bddd-4501ce3b8fed.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/93bbcff0-ebe3-43e9-91d2-3c305df68599.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/59330e47-7605-473a-973b-3343b8179302.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/cd17eb14-bfad-4b52-9a1c-586738acc0c5.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/22213165-6445-4d76-9238-3a61a5378d9a.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/2567d100-a7c8-43f1-b1b7-5c32d655ccd3.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/9bc5ff3c-4dfd-4023-90ca-bb8983e99b0f.jpg)

---

## Masonry 瀑布流

![](https://xcimg.szwego.com/img/f71fe4b2/51a974ab-1d20-4d79-8948-89ecbde2afcd.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/9bc5ff3c-4dfd-4023-90ca-bb8983e99b0f.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/9761a552-1e29-41ed-8826-5f5e264b4d56.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/b17c71b0-8a93-4b4f-a884-0a6d304058f3.jpg)
![](https://xcimg.szwego.com/img/f71fe4b2/ea74bf29-a000-49d9-9f04-49383eaf0a7c.jpeg)
![](https://xcimg.szwego.com/img/f71fe4b2/93bbcff0-ebe3-43e9-91d2-3c305df68599.jpg)

---

## 折叠内容 (Details)

::: details{summary="点击展开查看更多内容"}
这里是被折叠的内容。

可以包含任何 Markdown 格式：

列表项 1

列表项 2


:::

::: details{summary="另一个折叠块"}
表头1

表头2

内容1

内容2
:::

---

## 视频嵌入

<video src="https://xcimg.szwego.com/pvod/f71fe4b2/124790f5-c9f8-4123-a94e-a5ea7034fc26.mp4" controls></video>

---

## Mermaid 图表

```mermaid
graph TD
    A[开始] --> B{判断条件}
    B -->|是| C[执行操作A]
    B -->|否| D[执行操作B]
    C --> E[结束]
    D --> E
```

```mermaid
sequenceDiagram
    participant 用户
    participant 前端
    participant 后端
    participant 数据库

    用户->>前端: 发起请求
    前端->>后端: API 调用
    后端->>数据库: 查询数据
    数据库-->>后端: 返回结果
    后端-->>前端: JSON 响应
    前端-->>用户: 渲染页面
```

```mermaid
pie title 技术栈占比
    "React" : 40
    "TypeScript" : 30
    "Tailwind CSS" : 20
    "其他" : 10
```

```mermaid
gantt
    title 项目进度
    dateFormat  YYYY-MM-DD
    section 设计
    需求分析     :a1, 2024-01-01, 7d
    UI设计       :after a1, 5d
    section 开发
    前端开发     :2024-01-13, 14d
    后端开发     :2024-01-13, 14d
    section 测试
    测试         :2024-01-27, 7d
```

---

## 脚注

这是一段带有脚注的文本[^1]，还有另一个脚注[^2]。

[^1]: 这是第一个脚注的内容，包含一些详细说明。
[^2]: 第二个脚注引用了相关资料和参考链接。

---

## HTML 标签支持

`Ctrl` + `C` 复制

`Ctrl` + `V` 粘贴

==这是使用 HTML mark 标签的高亮==

`HTML` 是一种标记语言。

++这是插入的文本++

~~这是删除的文本~~

这是小号文本

^上标文本^ 和 ~下标文本~

---

## Tag 标签

`标签1` `标签2` `React` `TypeScript`

---

## 特殊字符转义

\*这不是斜体\*

\`这不是代码\`

[这不是链接](url)

---

## 总结

以上就是 Shiroi 博客系统支持的所有 Markdown 渲染功能测试。包括：

1. 基础 Markdown 语法（标题、粗体、斜体、删除线）
2. GFM 扩展（表格、任务列表）
3. 代码高亮（Shiki 引擎，支持多种语言）
4. 数学公式（KaTeX，行内和块级）
5. 图片与画廊（Gallery、Grid、Masonry）
6. 富链接卡片自动解析：
7. GitHub 仓库/Commit/PR/文件预览
8. Twitter/X 推文嵌入
9. YouTube 视频嵌入
10. GitHub Gist 嵌入
11. CodeSandbox 嵌入
12. Bilibili 视频嵌入
13. Arxiv 论文
14. Bangumi 番剧
15. LeetCode 题目
16. 网易云/QQ 音乐
17. TMDB 影视
18. 站内文章
19. LinkCard 组件（手动指定类型）
20. Container 容器（Banner、Grid、Gallery、Masonry）
21. 折叠内容（Details）
22. Mermaid 图表（流程图、时序图、饼图、甘特图）
23. Excalidraw 手绘图
24. 远程 React 组件嵌入
25. GitHub 风格 Alerts（NOTE、TIP、IMPORTANT、WARNING、CAUTION）
26. @ 提及（GitHub/Twitter/Telegram）
27. 剧透文本（||spoiler||）
28. 高亮标记（==mark==）
29. 插入文本（++insert++）
30. 脚注
31. 视频嵌入
32. HTML 标签支持（kbd、sup、sub、mark、abbr 等）
33. Tag 标签组件

---

*最后更新：2026-01-11*