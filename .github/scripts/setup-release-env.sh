#!/usr/bin/env bash
set -euo pipefail

PUBLIC_REPO="LodyAI/Lody"
PRIVATE_REPO="loro-dev/lody"
ENVS=("cloud-nightly" "cloud-production")

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "=== 1. 检查 gh 登录状态 ==="
gh auth status >/dev/null

echo ""
echo "=== 2. 飞书报警群机器人配置 ==="
read -rp "飞书 Webhook URL (https://open.feishu.cn/open-apis/bot/v2/hook/...): " FEISHU_URL
if [[ -z "${FEISHU_URL}" ]]; then
  echo "错误：FEISHU_ALERT_WEBHOOK_URL 不能为空" >&2
  exit 1
fi
read -rsp "飞书签名密钥 Secret（未开启签名校验直接回车跳过）: " FEISHU_SECRET
echo ""
read -rp "发包成功时是否也发飞书通知？[y/N]: " NOTIFY_SUCCESS

echo ""
read -rp "是否先往飞书群发一条连通性测试消息？[Y/n]: " TEST_FEISHU
if [[ ! "${TEST_FEISHU:-Y}" =~ ^[Nn]$ ]]; then
  FEISHU_URL="$FEISHU_URL" FEISHU_SECRET="$FEISHU_SECRET" node -e '
    const crypto = require("node:crypto");
    const url = process.env.FEISHU_URL;
    const secret = process.env.FEISHU_SECRET;
    const payload = {
      msg_type: "interactive",
      card: {
        header: { title: { tag: "plain_text", content: "Lody 发布告警配置测试" }, template: "blue" },
        elements: [{ tag: "markdown", content: "飞书报警群 Webhook 连通性测试成功。" }]
      }
    };
    if (secret) {
      const ts = String(Math.floor(Date.now() / 1000));
      payload.timestamp = ts;
      payload.sign = crypto.createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
    }
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok || (data.code ?? data.StatusCode ?? 0) !== 0) {
        console.error("飞书测试失败:", data);
        process.exit(1);
      }
      console.log("✅ 飞书测试消息已送达！");
    });
  '
fi

echo ""
echo "=== 3. 私仓 Self-Host E2E 只读 Deploy SSH Key ==="
read -rp "是否自动生成一把只读 Deploy SSH Key，添加到 ${PRIVATE_REPO} 并写入 ${PUBLIC_REPO}？[Y/n]: " SETUP_SSH
SSH_KEY_FILE=""
if [[ ! "${SETUP_SSH:-Y}" =~ ^[Nn]$ ]]; then
  KEY_TITLE="lody-release-e2e-readonly-$(date +%Y%m%d)"
  SSH_KEY_FILE="${TMP_DIR}/deploy_ed25519"
  ssh-keygen -t ed25519 -N "" -C "${KEY_TITLE}" -f "${SSH_KEY_FILE}" >/dev/null
  echo "-> 正在向 ${PRIVATE_REPO} 添加只读 Deploy Key (${KEY_TITLE})..."
  gh repo deploy-key add "${SSH_KEY_FILE}.pub" -R "${PRIVATE_REPO}" --title "${KEY_TITLE}"
  echo "✅ 只读 Deploy Key 已添加到 ${PRIVATE_REPO}（临时私钥脚本结束后会自动删除）"
fi

echo ""
echo "=== 4. 写入 ${PUBLIC_REPO} GitHub Environments (${ENVS[*]}) ==="
for env_name in "${ENVS[@]}"; do
  echo "-> 配置环境: ${env_name}"
  printf '%s' "$FEISHU_URL" | gh secret set FEISHU_ALERT_WEBHOOK_URL -R "$PUBLIC_REPO" --env "$env_name"

  if [[ -n "${FEISHU_SECRET}" ]]; then
    printf '%s' "$FEISHU_SECRET" | gh secret set FEISHU_ALERT_WEBHOOK_SECRET -R "$PUBLIC_REPO" --env "$env_name"
  fi

  if [[ "${NOTIFY_SUCCESS:-N}" =~ ^[Yy]$ ]]; then
    gh variable set FEISHU_NOTIFY_ON_SUCCESS -R "$PUBLIC_REPO" --env "$env_name" --body "1"
  fi

  if [[ -n "${SSH_KEY_FILE}" ]]; then
    gh secret set PRIVATE_SOURCE_SSH_KEY -R "$PUBLIC_REPO" --env "$env_name" < "${SSH_KEY_FILE}"
    gh variable set SELFHOST_E2E_ENABLED -R "$PUBLIC_REPO" --env "$env_name" --body "true"
  fi
done

echo ""
echo "🎉 全部配置完成！已写入的项："
for env_name in "${ENVS[@]}"; do
  echo "--- ${env_name} ---"
  gh secret list -R "$PUBLIC_REPO" --env "$env_name" | grep -E 'FEISHU_|PRIVATE_SOURCE_' || true
  gh variable list -R "$PUBLIC_REPO" --env "$env_name" | grep -E 'FEISHU_|SELFHOST_E2E_' || true
done
