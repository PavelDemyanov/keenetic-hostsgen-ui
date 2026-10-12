/*
 * hostsgen-ui — помощник модуля «Добавить списком» для веб-интерфейса KeeneticOS.
 * Статическая программа без зависимостей: работает и в голой прошивке (там нет даже mount и awk),
 * и рядом с Entware.
 *
 *   hostsgen-ui start            встроить addon.js в веб-интерфейс: копия index.html + mount --bind
 *   hostsgen-ui stop             вернуть родные файлы интерфейса
 *   hostsgen-ui status           встроен ли модуль
 *   hostsgen-ui resolve HOSTS…   IPv4-адреса доменов через DNS роутера, по строке на домен:
 *                                «домен ip1 ip2 …» или «домен -»; домены — через запятую или пробел
 *   hostsgen-ui version
 *
 * resolve вызывает веб-модуль RCI-командой exec. start при каждом запуске кладёт копию программы
 * в HOME/hostsgen-ui — по этому пути её и вызывает веб-модуль.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <syslog.h>
#include <time.h>
#include <unistd.h>

#define VERSION "1.0.0"
#define HOME "/opt/share/hostsgen-ui"
#define ADDON HOME "/addon.js"
#define SELF HOME "/hostsgen-ui"
#define WWW "/usr/share/htdocs_"
#define RUN "/tmp/hostsgen-ui"

#define MAX_HOSTS 64 // за один вызов resolve; веб-модуль шлёт по 30
#define MAX_IPS 32
#define PARALLEL 12

static const char *const PAGES[] = {"index.html", "index-cloud.html"};

/* Запись в журнал роутера. syslog() из musl ставит время в UTC, а журнал KeeneticOS показывает его
 * как есть, поэтому строку с местным временем отправляем в /dev/log сами. */
static void log_line(int priority, const char *text) {
	int fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	if (fd < 0) return;
	struct sockaddr_un addr = {.sun_family = AF_UNIX, .sun_path = "/dev/log"};
	char stamp[32], line[640];
	time_t now = time(NULL);
	struct tm tm;
	strftime(stamp, sizeof stamp, "%b %e %T", localtime_r(&now, &tm));
	int n = snprintf(line, sizeof line, "<%d>%s hostsgen-ui[%d]: %s", LOG_USER | priority, stamp, (int)getpid(), text);
	if (n > 0) sendto(fd, line, (size_t)n < sizeof line ? (size_t)n : sizeof line - 1, 0, (struct sockaddr *)&addr, sizeof addr);
	close(fd);
}

/* Сообщение и в вывод (его видят RCI exec и консоль), и в журнал роутера. */
static void say(int priority, const char *fmt, ...) {
	char text[512];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(text, sizeof text, fmt, ap);
	va_end(ap);
	fprintf(priority <= LOG_WARNING ? stderr : stdout, "%s\n", text);
	log_line(priority, text);
}

static char *read_file(const char *path, size_t *len) {
	FILE *f = fopen(path, "rb");
	if (!f) return NULL;
	size_t cap = 1 << 16, n = 0;
	char *buf = malloc(cap + 1);
	while (buf) {
		n += fread(buf + n, 1, cap - n, f);
		if (n < cap) break;
		char *bigger = realloc(buf, cap * 2 + 1);
		if (!bigger) {
			free(buf);
			buf = NULL;
			break;
		}
		buf = bigger;
		cap *= 2;
	}
	if (buf && ferror(f)) {
		free(buf);
		buf = NULL;
	}
	fclose(f);
	if (buf) {
		buf[n] = 0;
		*len = n;
	}
	return buf;
}

static int is_mounted(const char *target) {
	FILE *f = fopen("/proc/mounts", "r");
	if (!f) return 0;
	char line[1024], dev[256], dir[512];
	int found = 0;
	while (!found && fgets(line, sizeof line, f))
		found = sscanf(line, "%255s %511s", dev, dir) == 2 && strcmp(dir, target) == 0;
	fclose(f);
	return found;
}

static int unmount_all(const char *target) {
	while (is_mounted(target)) {
		if (umount2(target, 0) != 0) {
			say(LOG_ERR, "не удалось снять %s: %s", target, strerror(errno));
			return -1;
		}
	}
	return 0;
}

/* Копия программы по постоянному пути — для веб-модуля. Обновляется, если сборка изменилась. */
static void install_self(void) {
	char self[512];
	ssize_t n = readlink("/proc/self/exe", self, sizeof self - 1);
	if (n <= 0) return;
	self[n] = 0;
	if (strcmp(self, SELF) == 0) return;

	size_t len, old_len;
	char *bin = read_file("/proc/self/exe", &len);
	if (!bin) return;
	char *old = read_file(SELF, &old_len);
	int same = old && old_len == len && memcmp(old, bin, len) == 0;
	free(old);
	if (!same) {
		FILE *f = fopen(SELF ".new", "wb");
		int ok = f && fwrite(bin, 1, len, f) == len;
		if (f && fclose(f) != 0) ok = 0;
		if (ok && chmod(SELF ".new", 0755) == 0 && rename(SELF ".new", SELF) == 0)
			say(LOG_INFO, "программа обновлена: %s", SELF);
		else {
			say(LOG_ERR, "не удалось записать %s: %s", SELF, strerror(errno));
			unlink(SELF ".new");
		}
	}
	free(bin);
}

/* Копия страницы с addon.js перед </body>, смонтированная поверх оригинала. */
static int patch_page(const char *page, const char *addon, size_t addon_len) {
	char target[256], copy[256];
	snprintf(target, sizeof target, "%s/%s", WWW, page);
	snprintf(copy, sizeof copy, "%s/%s", RUN, page);
	if (access(target, F_OK) != 0) return 0; // такой страницы в этой прошивке нет
	if (unmount_all(target) != 0) return -1;

	size_t len;
	char *html = read_file(target, &len);
	if (!html) {
		say(LOG_ERR, "не удалось прочитать %s: %s", target, strerror(errno));
		return -1;
	}
	char *body = strstr(html, "</body>");
	if (!body) {
		say(LOG_WARNING, "%s: нет </body>, пропускаю", page);
		free(html);
		return 0;
	}
	FILE *f = fopen(copy, "wb");
	int ok = f != NULL;
	if (ok) {
		ok = fwrite(html, 1, (size_t)(body - html), f) == (size_t)(body - html) &&
		     fputs("<script data-hostsgen-ui>\n", f) >= 0 && fwrite(addon, 1, addon_len, f) == addon_len &&
		     fputs("</script>", f) >= 0 && fputs(body, f) >= 0;
		if (fclose(f) != 0) ok = 0;
	}
	free(html);
	if (!ok) {
		say(LOG_ERR, "не удалось записать %s: %s", copy, strerror(errno));
		return -1;
	}
	if (mount(copy, target, NULL, MS_BIND, NULL) != 0) {
		say(LOG_ERR, "не удалось смонтировать %s: %s", target, strerror(errno));
		return -1;
	}
	say(LOG_INFO, "%s: модуль встроен", page);
	return 0;
}

static int cmd_start(void) {
	install_self();
	size_t len;
	char *addon = read_file(ADDON, &len);
	if (!addon) {
		say(LOG_ERR, "нет %s", ADDON);
		return 1;
	}
	if (strcasestr(addon, "</script")) {
		say(LOG_ERR, "в addon.js есть закрывающий тег script — встраивать нельзя");
		free(addon);
		return 1;
	}
	if (mkdir(RUN, 0755) != 0 && errno != EEXIST) {
		say(LOG_ERR, "не удалось создать %s: %s", RUN, strerror(errno));
		free(addon);
		return 1;
	}
	int failed = 0;
	for (size_t i = 0; i < sizeof PAGES / sizeof *PAGES; i++) failed |= patch_page(PAGES[i], addon, len) != 0;
	free(addon);
	return failed;
}

static int cmd_stop(void) {
	int failed = 0;
	char path[256];
	for (size_t i = 0; i < sizeof PAGES / sizeof *PAGES; i++) {
		snprintf(path, sizeof path, "%s/%s", WWW, PAGES[i]);
		if (is_mounted(path)) {
			if (unmount_all(path) == 0) say(LOG_INFO, "%s: возвращён родной файл", PAGES[i]);
			else failed = 1;
		}
		snprintf(path, sizeof path, "%s/%s", RUN, PAGES[i]);
		unlink(path);
	}
	rmdir(RUN);
	return failed;
}

static int cmd_status(void) {
	char path[256];
	for (size_t i = 0; i < sizeof PAGES / sizeof *PAGES; i++) {
		snprintf(path, sizeof path, "%s/%s", WWW, PAGES[i]);
		if (access(path, F_OK) == 0) printf("%s: %s\n", PAGES[i], is_mounted(path) ? "модуль встроен" : "родной");
	}
	return 0;
}

// ---------- resolve ----------

struct job {
	const char *host;
	char out[MAX_IPS * 16 + 260];
};

static int valid_host(const char *h) {
	size_t n = strlen(h);
	if (n == 0 || n > 253 || h[0] == '-' || h[0] == '.') return 0;
	for (; *h; h++)
		if (!((*h >= 'a' && *h <= 'z') || (*h >= 'A' && *h <= 'Z') || (*h >= '0' && *h <= '9') || *h == '.' ||
		      *h == '-' || *h == '_'))
			return 0;
	return 1;
}

static void *lookup(void *arg) {
	struct job *job = arg;
	struct addrinfo hints = {.ai_family = AF_INET, .ai_socktype = SOCK_STREAM}, *res = NULL;
	size_t used = (size_t)snprintf(job->out, sizeof job->out, "%s", job->host);
	uint32_t seen[MAX_IPS];
	int count = 0;
	if (getaddrinfo(job->host, NULL, &hints, &res) == 0) {
		for (struct addrinfo *a = res; a && count < MAX_IPS; a = a->ai_next) {
			struct in_addr addr = ((struct sockaddr_in *)a->ai_addr)->sin_addr;
			int dup = 0;
			for (int i = 0; i < count && !dup; i++) dup = seen[i] == addr.s_addr;
			if (dup) continue;
			seen[count++] = addr.s_addr;
			char ip[INET_ADDRSTRLEN];
			inet_ntop(AF_INET, &addr, ip, sizeof ip);
			used += (size_t)snprintf(job->out + used, sizeof job->out - used, " %s", ip);
		}
		freeaddrinfo(res);
	}
	if (!count) snprintf(job->out + used, sizeof job->out - used, " -");
	return NULL;
}

static int cmd_resolve(int argc, char **argv) {
	static struct job jobs[MAX_HOSTS];
	int n = 0;
	for (int i = 0; i < argc && n < MAX_HOSTS; i++)
		for (char *save, *tok = strtok_r(argv[i], ", \t\r\n", &save); tok && n < MAX_HOSTS;
		     tok = strtok_r(NULL, ", \t\r\n", &save))
			if (valid_host(tok)) jobs[n++].host = tok;

	pthread_attr_t attr;
	pthread_attr_init(&attr);
	pthread_attr_setstacksize(&attr, 256 * 1024);
	for (int i = 0; i < n; i += PARALLEL) {
		pthread_t threads[PARALLEL];
		int started[PARALLEL] = {0};
		for (int k = 0; k < PARALLEL && i + k < n; k++) {
			started[k] = pthread_create(&threads[k], &attr, lookup, &jobs[i + k]) == 0;
			if (!started[k]) lookup(&jobs[i + k]);
		}
		for (int k = 0; k < PARALLEL && i + k < n; k++)
			if (started[k]) pthread_join(threads[k], NULL);
	}
	for (int i = 0; i < n; i++) puts(jobs[i].out);
	return 0;
}

/* Часовой пояс прошивка держит в /var/TZ, без него время в журнале роутера было бы в UTC. */
static void load_timezone(void) {
	if (getenv("TZ")) return;
	char tz[64] = "";
	FILE *f = fopen("/var/TZ", "r");
	if (!f) return;
	if (fgets(tz, sizeof tz, f)) {
		tz[strcspn(tz, "\r\n")] = 0;
		if (*tz) setenv("TZ", tz, 1);
	}
	fclose(f);
	tzset();
}

int main(int argc, char **argv) {
	const char *cmd = argc > 1 ? argv[1] : "";
	load_timezone();
	// start/stop/restart/status приходят и от rc.unslung Entware, и от initrc из архива
	if (strcmp(cmd, "start") == 0) return cmd_start();
	if (strcmp(cmd, "stop") == 0 || strcmp(cmd, "kill") == 0) return cmd_stop();
	if (strcmp(cmd, "restart") == 0) {
		cmd_stop();
		return cmd_start();
	}
	if (strcmp(cmd, "status") == 0 || strcmp(cmd, "check") == 0) return cmd_status();
	if (strcmp(cmd, "resolve") == 0) return cmd_resolve(argc - 2, argv + 2);
	if (strcmp(cmd, "version") == 0) {
		puts(VERSION);
		return 0;
	}
	fprintf(stderr, "Использование: %s {start|stop|restart|status|resolve ДОМЕНЫ|version}\n", argv[0]);
	return 2;
}
