#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

/* Read the kernel footprint counter without walking a changing VM-region map. */
int main(int argc, char **argv) {
  printf("[");
  for (int i = 1; i < argc; i++) {
    char *end;
    long pid = strtol(argv[i], &end, 10);
    if (*end || pid <= 0 || pid > INT_MAX) return 2;
    struct rusage_info_v4 info = {0};
    if (i > 1) printf(",");
    if (proc_pid_rusage((int)pid, RUSAGE_INFO_V4, (rusage_info_t *)&info) == 0) {
      printf("{\"pid\":%ld,\"physFootprintBytes\":%" PRIu64 "}", pid, info.ri_phys_footprint);
    } else if (errno == ESRCH) {
      printf("{\"pid\":%ld,\"exited\":true}", pid);
    } else {
      perror("proc_pid_rusage");
      return 1;
    }
  }
  printf("]\n");
  return 0;
}
