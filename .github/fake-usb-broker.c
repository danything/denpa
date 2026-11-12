/*
 * USB_BROKER に繋ぐ偽のアプリ (.github/android-agent-smoke.sh がエミュレータで使う)。エミュレータには USB の機材を挿せないので、
 * アプリ (Kotlin) の代わりに、エージェントとの取り決め (docs/agent.md「Android でアプリから USB を受け取る」) どおりに行を送る。
 *
 *   fake-usb-broker <ソケット> <ファイル> <行>...
 *
 * 行は 1 つずつ 1 回の sendmsg で送る (終わりに改行を足す)。"attached" を含む行には、<ファイル> を開いた fd を SCM_RIGHTS で 1 つ付ける。
 * エージェントが待ち受けるまで、10 秒まで繋ぎ直す
 */
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <socket> <file> <line>...\n", argv[0]);
    return 2;
  }
  int sock = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  if (sock < 0 || strlen(argv[1]) >= sizeof address.sun_path) {
    perror("socket");
    return 1;
  }
  strcpy(address.sun_path, argv[1]);
  for (int tries = 0; connect(sock, (struct sockaddr *)&address, sizeof address) != 0; tries++) {
    if (tries >= 100) {
      perror("connect");
      return 1;
    }
    usleep(100 * 1000);
  }
  for (int i = 3; i < argc; i++) {
    char line[4096];
    int length = snprintf(line, sizeof line, "%s\n", argv[i]);
    if (length < 0 || length >= (int)sizeof line) {
      fprintf(stderr, "line too long\n");
      return 1;
    }
    struct iovec vector = {.iov_base = line, .iov_len = (size_t)length};
    struct msghdr message = {.msg_iov = &vector, .msg_iovlen = 1};
    union {
      char bytes[CMSG_SPACE(sizeof(int))];
      struct cmsghdr align;
    } control;
    int file = -1;
    if (strstr(argv[i], "\"attached\"") != NULL) {
      file = open(argv[2], O_RDONLY | O_CLOEXEC);
      if (file < 0) {
        perror("open");
        return 1;
      }
      memset(&control, 0, sizeof control);
      message.msg_control = control.bytes;
      message.msg_controllen = sizeof control.bytes;
      struct cmsghdr *header = CMSG_FIRSTHDR(&message);
      header->cmsg_level = SOL_SOCKET;
      header->cmsg_type = SCM_RIGHTS;
      header->cmsg_len = CMSG_LEN(sizeof(int));
      memcpy(CMSG_DATA(header), &file, sizeof(int));
    }
    if (sendmsg(sock, &message, 0) != length) {
      perror("sendmsg");
      return 1;
    }
    if (file >= 0) close(file);
  }
  close(sock);
  return 0;
}
