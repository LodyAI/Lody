export type MainWindowRuntimePolicyInput = {
  isPackaged: boolean
  e2eFlag?: string
  showE2EWindowFlag?: string
}

export type MainWindowRuntimePolicy = {
  backgroundThrottling: boolean
  showWhenReady: boolean
}

export function resolveMainWindowRuntimePolicy(
  input: MainWindowRuntimePolicyInput
): MainWindowRuntimePolicy {
  const isUnpackagedE2E = !input.isPackaged && input.e2eFlag === '1'

  return {
    backgroundThrottling: !isUnpackagedE2E,
    showWhenReady: !isUnpackagedE2E || input.showE2EWindowFlag === '1'
  }
}
