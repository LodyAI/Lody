// Windows-only process boundary. The supervisor alone owns the job handle.
// Spawn with pipes for fd 0..3 and arguments: --owner-pid PID -- EXE [ARG...].
// EXE must be absolute. Environment/cwd and standard streams pass through unchanged.
// fd 3 protocol (ASCII, newline-delimited):
//   supervisor: {"type":"ready","protocol":1}   parent: start\n
//   supervisor: {"type":"prepared","pid":PID}   parent: resume\n
//   supervisor: {"type":"started"}
// Keep fd 3 open until exit. EOF or unexpected input cancels the owned job.
// Startup failures report only stage and numeric Windows error, never arguments.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <io.h>
#include <stdlib.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <limits>
#include <string>
#include <vector>

namespace {
constexpr DWORD kStartupTimeoutMs = 10000;
constexpr DWORD kSupervisorFailure = 125;
constexpr DWORD kOwnerGone = 124;

struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE handle = nullptr) : value(handle) {}
  ~Handle() {
    if (value != nullptr && value != INVALID_HANDLE_VALUE) CloseHandle(value);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

bool WriteStatus(HANDLE control, const std::string& message) {
  if (control == nullptr || control == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  return WriteFile(control, message.data(), static_cast<DWORD>(message.size()),
                   &written, nullptr) && written == message.size();
}

[[noreturn]] void Fail(HANDLE control, const char* stage, DWORD error) {
  const std::string status = std::string("{\"type\":\"error\",\"stage\":\"") +
                            stage + "\",\"code\":" + std::to_string(error) + "}\n";
  WriteStatus(control, status);
  // This executable is the process boundary. The kernel closes every handle,
  // including the only job handle, even if a control reader is blocked.
  ExitProcess(kSupervisorFailure);
}

struct ReadCommand {
  HANDLE pipe;
  const char* expected;
  bool matched = false;
};

DWORD WINAPI ReadExpectedCommand(void* argument) {
  auto* request = static_cast<ReadCommand*>(argument);
  for (const char* next = request->expected; *next != '\0'; ++next) {
    char byte = 0;
    DWORD received = 0;
    if (!ReadFile(request->pipe, &byte, 1, &received, nullptr) || received != 1 ||
        byte != *next) return 0;
  }
  request->matched = true;
  return 0;
}

void AwaitCommand(HANDLE control, HANDLE owner, const char* expected) {
  ReadCommand request{control, expected};
  Handle reader(CreateThread(nullptr, 0, ReadExpectedCommand, &request, 0, nullptr));
  if (reader.value == nullptr) Fail(control, "handshake-thread", GetLastError());
  const HANDLE waits[] = {owner, reader.value};
  const DWORD result = WaitForMultipleObjects(2, waits, FALSE, kStartupTimeoutMs);
  if (result == WAIT_OBJECT_0) ExitProcess(kOwnerGone);
  if (result == WAIT_TIMEOUT) Fail(control, "handshake-timeout", WAIT_TIMEOUT);
  if (result != WAIT_OBJECT_0 + 1) Fail(control, "handshake-wait", GetLastError());
  if (!request.matched) Fail(control, "handshake", ERROR_INVALID_DATA);
  // Reader has exited before its stack argument or thread handle is released.
}

DWORD WINAPI WaitForControlClosure(void* argument) {
  const HANDLE control = static_cast<HANDLE>(argument);
  char byte = 0;
  DWORD received = 0;
  // EOF, read failure, or an unexpected command all withdraw ownership.
  ReadFile(control, &byte, 1, &received, nullptr);
  return 0;
}

bool ParsePid(const wchar_t* text, DWORD& result) {
  if (*text == L'\0') return false;
  std::uint64_t value = 0;
  for (const wchar_t* next = text; *next != L'\0'; ++next) {
    if (*next < L'0' || *next > L'9') return false;
    value = value * 10 + static_cast<unsigned>(*next - L'0');
    if (value > std::numeric_limits<DWORD>::max()) return false;
  }
  if (value == 0) return false;
  result = static_cast<DWORD>(value);
  return true;
}

bool IsAbsolute(const std::wstring& path) {
  return (path.size() >= 3 && path[1] == L':' &&
          (path[2] == L'\\' || path[2] == L'/')) ||
         (path.size() >= 3 && path[0] == L'\\' && path[1] == L'\\');
}

// Quote one argv element for the Windows CRT parser. Backslashes are doubled
// only before a quote or the closing quote; no shell interprets this string.
std::wstring QuoteArgument(const wchar_t* argument) {
  std::wstring quoted = L"\"";
  std::size_t slashes = 0;
  for (const wchar_t* next = argument; *next != L'\0'; ++next) {
    if (*next == L'\\') {
      ++slashes;
      continue;
    }
    if (*next == L'\"') {
      quoted.append(slashes * 2 + 1, L'\\');
    } else {
      quoted.append(slashes, L'\\');
    }
    quoted.push_back(*next);
    slashes = 0;
  }
  quoted.append(slashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  // A missing fd 3 is a launch-contract failure, not a CRT crash dialog.
  _set_invalid_parameter_handler([](const wchar_t*, const wchar_t*, const wchar_t*,
                                    unsigned, uintptr_t) {});
  const intptr_t descriptor = _get_osfhandle(3);
  const HANDLE control = descriptor == -1 ? INVALID_HANDLE_VALUE
                                          : reinterpret_cast<HANDLE>(descriptor);
  if (control == INVALID_HANDLE_VALUE) return static_cast<int>(kSupervisorFailure);
  if (!SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0)) {
    Fail(control, "control-handle", GetLastError());
  }
  DWORD ownerPid = 0;
  if (argc < 5 || std::wcscmp(argv[1], L"--owner-pid") != 0 ||
      std::wcscmp(argv[3], L"--") != 0 || !ParsePid(argv[2], ownerPid) ||
      !IsAbsolute(argv[4])) {
    Fail(control, "arguments", ERROR_INVALID_PARAMETER);
  }
  Handle owner(OpenProcess(SYNCHRONIZE, FALSE, ownerPid));
  if (owner.value == nullptr) Fail(control, "owner-handle", GetLastError());
  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (job.value == nullptr) Fail(control, "create-job", GetLastError());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    Fail(control, "job-limits", GetLastError());
  }
  if (!WriteStatus(control, "{\"type\":\"ready\",\"protocol\":1}\n")) {
    ExitProcess(kSupervisorFailure);
  }
  // The parent must answer AFTER its handle was captured. A reused owner PID
  // cannot authorize startup after the original parent/pipe writer has died.
  AwaitCommand(control, owner.value, "start\n");

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  std::vector<HANDLE> inherited;
  for (HANDLE stream : {startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput,
                        startup.StartupInfo.hStdError}) {
    if (stream == nullptr || stream == INVALID_HANDLE_VALUE) {
      Fail(control, "standard-stream", ERROR_INVALID_HANDLE);
    }
    if (!SetHandleInformation(stream, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
      Fail(control, "standard-stream", GetLastError());
    }
    bool duplicate = false;
    for (HANDLE previous : inherited) duplicate = duplicate || previous == stream;
    if (!duplicate) inherited.push_back(stream);
  }

  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeBytes);
  std::vector<unsigned char> attributes(attributeBytes);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &attributeBytes)) {
    Fail(control, "startup-attributes", GetLastError());
  }
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                 &job.value, sizeof(job.value), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 inherited.data(), inherited.size() * sizeof(HANDLE), nullptr,
                                 nullptr)) {
    Fail(control, "startup-attributes", GetLastError());
  }
  std::wstring commandLine;
  for (int index = 4; index < argc; ++index) {
    if (!commandLine.empty()) commandLine.push_back(L' ');
    commandLine += QuoteArgument(argv[index]);
  }
  if (commandLine.size() >= 32767) Fail(control, "command-length", ERROR_INVALID_PARAMETER);
  if (WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT) ExitProcess(kOwnerGone);

  PROCESS_INFORMATION process{};
  // JOB_LIST makes association atomic with creation, including a supervisor
  // crash inside CreateProcess. No running or suspended unowned-child window.
  const BOOL created = CreateProcessW(
      argv[4], commandLine.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
          EXTENDED_STARTUPINFO_PRESENT,
      nullptr, nullptr, &startup.StartupInfo, &process);
  const DWORD creationError = GetLastError();
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (!created) Fail(control, "create-process", creationError);
  Handle child(process.hProcess);
  Handle primaryThread(process.hThread);
  if (!WriteStatus(control, "{\"type\":\"prepared\",\"pid\":" +
                                std::to_string(process.dwProcessId) + "}\n")) {
    ExitProcess(kSupervisorFailure);
  }
  AwaitCommand(control, owner.value, "resume\n");
  if (WaitForSingleObject(owner.value, 0) != WAIT_TIMEOUT) ExitProcess(kOwnerGone);
  if (ResumeThread(primaryThread.value) == static_cast<DWORD>(-1)) {
    Fail(control, "resume", GetLastError());
  }
  CloseHandle(primaryThread.value);
  primaryThread.value = nullptr;
  if (!WriteStatus(control, "{\"type\":\"started\"}\n")) ExitProcess(kSupervisorFailure);

  Handle controlReader(CreateThread(nullptr, 0, WaitForControlClosure, control, 0, nullptr));
  if (controlReader.value == nullptr) Fail(control, "control-thread", GetLastError());
  const HANDLE waits[] = {owner.value, child.value, controlReader.value};
  const DWORD result = WaitForMultipleObjects(3, waits, FALSE, INFINITE);
  if (result == WAIT_OBJECT_0 || result == WAIT_OBJECT_0 + 2) ExitProcess(kOwnerGone);
  if (result != WAIT_OBJECT_0 + 1) Fail(control, "process-wait", GetLastError());
  DWORD exitCode = kSupervisorFailure;
  if (!GetExitCodeProcess(child.value, &exitCode)) Fail(control, "exit-code", GetLastError());
  ExitProcess(exitCode);
}
