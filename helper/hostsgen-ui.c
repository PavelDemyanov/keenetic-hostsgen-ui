/*
 * hostsgen-ui — помощник модулей веб-интерфейса KeeneticOS: «Добавить списком» в «Маршрутизации»
 * и «VPN на своём сервере» в «Других подключениях».
 * Статическая программа без зависимостей: работает и в голой прошивке (там нет даже mount и awk),
 * и рядом с Entware.
 *
 *   hostsgen-ui start            встроить addon.js в веб-интерфейс: копия index.html + mount --bind
 *   hostsgen-ui stop             вернуть родные файлы интерфейса
 *   hostsgen-ui status           встроен ли модуль
 *   hostsgen-ui resolve HOSTS…   IPv4-адреса доменов через DNS роутера, по строке на домен:
 *                                «домен ip1 ip2 …» или «домен -»; домены — через запятую или пробел
 *   hostsgen-ui vps-pad          одноразовая маска для пароля сервера (hex)
 *   hostsgen-ui vps-start АДРЕС ПОРТ ЛОГИН ПАРОЛЬ_XOR_МАСКА ВЕРСИЯ_AWG СЕТЬ [НАСТРОЙКИ_BASE64]
 *                                в фоне зайти на сервер по SSH и выполнить на нём vps-setup.sh
 *   hostsgen-ui vps-status [N]   состояние и журнал настройки начиная со строки N
 *   hostsgen-ui vps-cancel       прервать настройку
 *   hostsgen-ui vps-clear        удалить журнал (в нём ключ подключения)
 *   hostsgen-ui version
 *
 * resolve и vps-* вызывает веб-модуль RCI-командой exec. start при каждом запуске кладёт копию
 * программы в HOME/hostsgen-ui — по этому пути её и вызывает веб-модуль.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <syslog.h>
#include <time.h>
#include <unistd.h>

#define VERSION "1.2.0"
#define HOME "/opt/share/hostsgen-ui"
#define ADDON HOME "/addon.js"
#define SELF HOME "/hostsgen-ui"
#define WWW "/usr/share/htdocs_"
#define RUN "/tmp/hostsgen-ui"
#define OPT_SH "/opt/bin/sh"                // ею прошивка запускает initrc и скрипты из /opt
#define ENTWARE_BUSYBOX "/opt/bin/busybox"  // куда ведёт /opt/bin/sh у Entware

#define MAX_HOSTS 64 // за один вызов resolve; веб-модуль шлёт по 30
#define MAX_IPS 32
#define PARALLEL 12

// Сборка SSH-клиента dropbear под тот же процессор, что и эта программа (build.sh)
#if defined(__aarch64__)
#define ARCH "aarch64"
#elif defined(__mips__) && defined(__MIPSEL__)
#define ARCH "mipsel"
#elif defined(__mips__)
#define ARCH "mips"
#else
#define ARCH "unknown"
#endif
#define DBCLIENT HOME "/bin/dbclient." ARCH
#define VPS_SCRIPT HOME "/vps-setup.sh"
#define VPS RUN "/vps"
#define PAD_LEN 128          // самый длинный пароль сервера, байт
#define VPS_SILENCE 60       // сек: сервер так и не начал выполнять сценарий — недоступен
#define VPS_TIMEOUT 1800     // сек: дольше установка не идёт даже на медленном сервере
#define STATUS_LINES 200     // строк журнала за один vps-status
#define STATUS_LINE_MAX 400  // байт в строке журнала для веб-модуля
#define OPTIONS_MAX 8192     // настройки «Для опытных» в base64; ndm передаёт аргументы exec и длиннее

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

/* Прошивка запускает initrc и любые скрипты из /opt только через /opt/bin/sh, причём только если та
 * лежит в /opt; обычно её привозит Entware. Поэтому наш архив кладёт ссылку /opt/bin/sh на эту
 * программу (сборку под свой процессор). Если на накопителе Entware, распаковка подменила его ссылку
 * sh → busybox — возвращаем её (атомарно, через rename), чтобы его оболочка не изменилась. */
static void restore_entware_sh(void) {
	char target[256];
	ssize_t n = readlink(OPT_SH, target, sizeof target - 1);
	if (n <= 0) return;
	target[n] = 0;
	if (strncmp(target, HOME "/", strlen(HOME "/")) != 0 || access(ENTWARE_BUSYBOX, X_OK) != 0) return;
	// только в журнал: в режиме /opt/bin/sh наш вывод попал бы в вывод чужой команды
	char text[256];
	unlink(OPT_SH ".hostsgen-ui");
	if (symlink(ENTWARE_BUSYBOX, OPT_SH ".hostsgen-ui") == 0 && rename(OPT_SH ".hostsgen-ui", OPT_SH) == 0) {
		snprintf(text, sizeof text, "Entware: %s снова ведёт на %s", OPT_SH, ENTWARE_BUSYBOX);
		log_line(LOG_INFO, text);
	} else {
		snprintf(text, sizeof text, "Entware: не удалось вернуть %s → %s: %s", OPT_SH, ENTWARE_BUSYBOX, strerror(errno));
		log_line(LOG_ERR, text);
	}
}

static int cmd_start(void) {
	restore_entware_sh();
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

// ---------- vps: сервер AmneziaWG на своём VPS ----------
//
// Веб-модуль не может передать пароль аргументом открытым текстом: аргументы exec проходят через
// ndm и могут попасть в журнал. Поэтому сначала vps-pad выдаёт одноразовую маску, браузер шлёт
// пароль, сложенный с ней по XOR, а vps-start сразу удаляет маску. Дальше пароль живёт только
// в окружении dbclient (DROPBEAR_PASSWORD).
//
// vps-start отвязывается от exec (ndm ждёт закрытия вывода) и в фоне запускает dbclient, у которого
// stdin — переменные и vps-setup.sh, а stdout и stderr — журнал VPS/log. Веб-модуль читает журнал
// через vps-status; строки «@@…» в нём — шаги, ошибка и настройки подключения от vps-setup.sh.

static int write_text(const char *path, const char *text) {
	int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if (fd < 0) return -1;
	size_t len = strlen(text);
	int ok = write(fd, text, len) == (ssize_t)len;
	return close(fd) == 0 && ok ? 0 : -1;
}

static int make_dir(const char *path) { return mkdir(path, 0700) == 0 || errno == EEXIST ? 0 : -1; }

/* Фоновая настройка ещё идёт? В pid-файле — её процесс; проверяем, что это именно наша программа. */
static pid_t vps_job_pid(void) {
	size_t len;
	char *text = read_file(VPS "/pid", &len);
	if (!text) return 0;
	pid_t pid = (pid_t)atoi(text);
	free(text);
	if (pid <= 0 || kill(pid, 0) != 0) return 0;
	char link[64], exe[512], self[512];
	snprintf(link, sizeof link, "/proc/%d/exe", (int)pid);
	ssize_t a = readlink(link, exe, sizeof exe - 1), b = readlink("/proc/self/exe", self, sizeof self - 1);
	if (a <= 0 || b <= 0) return 0;
	exe[a] = self[b] = 0;
	return strcmp(exe, self) == 0 ? pid : 0;
}

static int cmd_vps_pad(void) {
	unsigned char pad[PAD_LEN];
	FILE *r = fopen("/dev/urandom", "rb");
	int ok = r && fread(pad, 1, sizeof pad, r) == sizeof pad;
	if (r) fclose(r);
	if (ok) ok = make_dir(RUN) == 0 && make_dir(VPS) == 0;
	int fd = ok ? open(VPS "/pad", O_WRONLY | O_CREAT | O_TRUNC, 0600) : -1;
	ok = fd >= 0 && write(fd, pad, sizeof pad) == (ssize_t)sizeof pad;
	if (fd >= 0 && close(fd) != 0) ok = 0;
	if (!ok) {
		say(LOG_ERR, "vps: не удалось создать маску: %s", strerror(errno));
		return 1;
	}
	for (size_t i = 0; i < sizeof pad; i++) printf("%02x", pad[i]);
	putchar('\n');
	memset(pad, 0, sizeof pad);
	return 0;
}

static int hex_value(char c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

static int valid_number(const char *s, long min, long max) {
	if (!*s || strlen(s) > 10 || strspn(s, "0123456789") != strlen(s)) return 0;
	long n = atol(s);
	return n >= min && n <= max;
}

static int valid_user(const char *u) {
	size_t n = strlen(u);
	return n > 0 && n <= 32 && strspn(u, "abcdefghijklmnopqrstuvwxyz0123456789_.-") == n && u[0] != '-' && u[0] != '.';
}

/* Первые три октета сети VPN: 10.X.Y */
static int valid_subnet(const char *s) {
	char copy[16];
	if (strlen(s) >= sizeof copy || strncmp(s, "10.", 3) != 0) return 0;
	strcpy(copy, s + 3);
	char *dot = strchr(copy, '.');
	if (!dot) return 0;
	*dot = 0;
	return valid_number(copy, 0, 255) && valid_number(dot + 1, 0, 255);
}

static volatile sig_atomic_t vps_cancelled;
static void on_vps_cancel(int sig) {
	(void)sig;
	vps_cancelled = 1;
}

/* Понятная причина, если сценарий на сервере так и не начался или оборвался без своей @@error. */
static const char *vps_failure(const char *log, char *buf, size_t size, const char *host, const char *port) {
	const char *p;
	if (!log) return "настройка прервалась";
	if (strstr(log, "Connect failed: Connection refused"))
		snprintf(buf, size, "сервер %s не принимает SSH-подключения на порту %s", host, port);
	else if ((p = strstr(log, "Connect failed: ")))
		snprintf(buf, size, "не удалось подключиться к серверу %s: %.*s", host, (int)strcspn(p + 16, "\r\n"), p + 16);
	else if (strstr(log, "Failed lookup"))
		snprintf(buf, size, "не удалось узнать адрес сервера %s", host);
	else if (strstr(log, "No auth methods could be used"))
		snprintf(buf, size, "сервер не принял логин или пароль (или вход по паролю на нём выключен)");
	else if (strstr(log, "Remote closed the connection") || strstr(log, "Disconnect received"))
		snprintf(buf, size, "сервер закрыл соединение");
	else
		snprintf(buf, size, "настройка прервалась — подробности в журнале");
	return buf;
}

/* Фоновый процесс: dbclient с vps-setup.sh, следит за временем, в конце пишет VPS/state. */
static void vps_job(const char *host, const char *port, const char *user, char *password) {
	int null = open("/dev/null", O_RDWR);
	if (null >= 0) {
		dup2(null, 0);
		dup2(null, 1);
		dup2(null, 2);
		if (null > 2) close(null);
	}
	if (chdir("/") != 0) _exit(1);
	signal(SIGTERM, on_vps_cancel);
	signal(SIGHUP, SIG_IGN);
	signal(SIGPIPE, SIG_IGN);
	char pid[16];
	snprintf(pid, sizeof pid, "%d\n", (int)getpid());
	write_text(VPS "/pid", pid);

	int log = open(VPS "/log", O_WRONLY | O_APPEND | O_CREAT, 0600);
	if (log < 0) _exit(1);
	dprintf(log, "@@step connect Подключаюсь к серверу %s\n", host);
	say(LOG_INFO, "vps: настраиваю сервер %s", host);

	pid_t child = fork();
	if (child == 0) {
		int in = open(VPS "/stdin", O_RDONLY);
		if (in < 0 || dup2(in, 0) < 0 || dup2(log, 1) < 0 || dup2(log, 2) < 0) _exit(127);
		close(in);
		close(log);
		setenv("DROPBEAR_PASSWORD", password, 1);
		setenv("HOME", VPS "/home", 1);
		char *args[] = {"dbclient", "-y", "-T", "-K", "20", "-o", "BatchMode=yes", "-p", (char *)port,
		                "-l", (char *)user, (char *)host, "sh -s", NULL};
		execv(DBCLIENT, args);
		dprintf(1, "@@error не удалось запустить SSH-клиент %s: %s\n", DBCLIENT, strerror(errno));
		_exit(127);
	}
	for (volatile char *p = password; *p; p++) *p = 0;

	const char *reason = NULL;
	time_t started = time(NULL);
	int answered = 0, status = 0;
	while (child > 0 && waitpid(child, &status, WNOHANG) == 0) {
		time_t now = time(NULL);
		if (!answered && now - started >= 3) {
			size_t len;
			char *text = read_file(VPS "/log", &len);
			answered = text && strstr(text, "\n@@step check") != NULL;
			free(text);
		}
		if (!reason && vps_cancelled) reason = "настройка отменена";
		if (!reason && !answered && now - started > VPS_SILENCE)
			reason = "сервер не отвечает — проверьте адрес и что VPS включён";
		if (!reason && now - started > VPS_TIMEOUT) reason = "настройка идёт больше 30 минут — прервал её";
		if (reason) {
			kill(child, SIGTERM);
			waitpid(child, &status, 0);
			break;
		}
		sleep(1);
	}

	size_t len;
	char *text = read_file(VPS "/log", &len), buf[256];
	int done = child > 0 && text && strstr(text, "\n@@done") != NULL;
	const char *error = reason;
	if (!done && !error) {
		const char *own = text ? strstr(text, "\n@@error ") : NULL;
		if (own) {
			snprintf(buf, sizeof buf, "%.*s", (int)strcspn(own + 9, "\n"), own + 9);
			error = buf;
		} else {
			error = vps_failure(text, buf, sizeof buf, host, port);
			dprintf(log, "@@error %s\n", error);
		}
	} else if (!done) {
		dprintf(log, "@@error %s\n", error);
	}
	free(text);
	close(log);
	write_text(VPS "/state", done ? "done\n" : "failed\n");
	if (done) say(LOG_INFO, "vps: сервер %s настроен", host);
	else say(LOG_ERR, "vps: сервер %s не настроен: %s", host, error);
	unlink(VPS "/pid");
	_exit(0);
}

/* Настройки «Для опытных»: base64 строк «Параметр = значение», их разбирает и проверяет vps-setup.sh */
static int valid_options(const char *s) {
	size_t n = strlen(s);
	return n <= OPTIONS_MAX && strspn(s, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") == n;
}

static int cmd_vps_start(int argc, char **argv) {
	if (argc != 6 && argc != 7) {
		fprintf(stderr, "vps-start АДРЕС ПОРТ ЛОГИН ПАРОЛЬ ВЕРСИЯ СЕТЬ [НАСТРОЙКИ]\n");
		return 2;
	}
	const char *host = argv[0], *port = argv[1], *user = argv[2], *secret = argv[3], *profile = argv[4],
	           *subnet = argv[5], *options = argc > 6 ? argv[6] : "";
	if (!valid_host(host) || !valid_number(port, 1, 65535) || !valid_user(user) || !valid_subnet(subnet) ||
	    !valid_options(options) || (strcmp(profile, "1") != 0 && strcmp(profile, "3") != 0)) {
		say(LOG_ERR, "vps: неверные параметры");
		return 2;
	}
	if (vps_job_pid()) {
		say(LOG_WARNING, "vps: настройка сервера уже идёт");
		return 1;
	}
	umask(077);

	// пароль: XOR с одноразовой маской из vps-pad; маска сразу удаляется
	size_t pad_len = 0, hex_len = strlen(secret);
	unsigned char *pad = (unsigned char *)read_file(VPS "/pad", &pad_len);
	unlink(VPS "/pad");
	char password[PAD_LEN + 1];
	size_t n = hex_len / 2;
	int ok = pad && hex_len % 2 == 0 && n > 0 && n <= pad_len && n <= PAD_LEN;
	for (size_t i = 0; ok && i < n; i++) {
		int hi = hex_value(secret[2 * i]), lo = hex_value(secret[2 * i + 1]);
		ok = hi >= 0 && lo >= 0;
		if (ok) password[i] = (char)((hi << 4 | lo) ^ pad[i]);
		ok = ok && password[i] != 0;
	}
	if (pad) memset(pad, 0, pad_len);
	free(pad);
	if (!ok) {
		say(LOG_ERR, "vps: не удалось расшифровать пароль — откройте окно настройки заново");
		return 1;
	}
	password[n] = 0;

	// stdin для «sh -s» на сервере: переменные, затем сам сценарий
	size_t script_len;
	char *script = read_file(VPS_SCRIPT, &script_len);
	FILE *in = script ? fopen(VPS "/stdin", "wb") : NULL;
	ok = in && fprintf(in, "PROFILE=%s\nSUBNET=%s\nENDPOINT=%s\n", profile, subnet, host) > 0 &&
	     (!*options || fprintf(in, "OPTIONS=%s\n", options) > 0) && fwrite(script, 1, script_len, in) == script_len;
	if (in && fclose(in) != 0) ok = 0;
	free(script);
	ok = ok && write_text(VPS "/log", "") == 0 && write_text(VPS "/state", "running\n") == 0 &&
	     make_dir(VPS "/home") == 0 && make_dir(VPS "/home/.ssh") == 0;
	unlink(VPS "/home/.ssh/known_hosts"); // новый сервер на старом адресе — не ошибка
	if (!ok || access(DBCLIENT, X_OK) != 0) {
		memset(password, 0, sizeof password);
		say(LOG_ERR, "vps: не готовы файлы модуля (%s, %s) — переустановите модуль", VPS_SCRIPT, DBCLIENT);
		return 1;
	}

	fflush(NULL);
	pid_t pid = fork();
	if (pid < 0) {
		memset(password, 0, sizeof password);
		say(LOG_ERR, "vps: fork: %s", strerror(errno));
		return 1;
	}
	if (pid == 0) {
		setsid();
		pid_t daemon = fork();
		if (daemon == 0) vps_job(host, port, user, password);
		_exit(daemon < 0);
	}
	memset(password, 0, sizeof password);
	int status;
	waitpid(pid, &status, 0);
	puts("started");
	return 0;
}

/* Строка журнала для веб-модуля. ndm обрывает вывод exec на управляющих символах («unable to communicate
 * with a process: invalid input»), а dpkg рисует прогресс через \r. Поэтому оставляем то, что показал бы
 * терминал, — текст после последнего \r; прочие управляющие символы заменяем пробелами, битый UTF-8 — «?». */
static void print_clean_line(const char *p, size_t n) {
	while (n && p[n - 1] == '\r') n--;
	const char *cr = memrchr(p, '\r', n);
	if (cr) {
		n -= (size_t)(cr + 1 - p);
		p = cr + 1;
	}
	char out[STATUS_LINE_MAX];
	size_t o = 0;
	for (size_t i = 0; i < n && o < sizeof out;) {
		unsigned char c = (unsigned char)p[i];
		size_t len = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 0;
		int ok = len > 0 && i + len <= n;
		for (size_t k = 1; ok && k < len; k++) ok = ((unsigned char)p[i + k] & 0xC0) == 0x80;
		if (!ok) {
			out[o++] = '?';
			i++;
		} else if (len == 1) {
			out[o++] = c < 0x20 || c == 0x7f ? ' ' : (char)c;
			i++;
		} else if (o + len <= sizeof out) {
			memcpy(out + o, p + i, len);
			o += len;
			i += len;
		} else {
			break; // не резать букву UTF-8 на границе
		}
	}
	printf("%.*s\n", (int)o, out);
}

/* «@@state running|done|failed|lost|none СЛЕДУЮЩАЯ_СТРОКА ВСЕГО_СТРОК», затем строки журнала с from-й. */
static int cmd_vps_status(int argc, char **argv) {
	long from = argc > 0 ? atol(argv[0]) : 0;
	size_t len = 0;
	char *state = read_file(VPS "/state", &len);
	const char *st = !state                               ? "none"
	                 : strncmp(state, "done", 4) == 0     ? "done"
	                 : strncmp(state, "failed", 6) == 0   ? "failed"
	                 : vps_job_pid()                      ? "running"
	                                                      : "lost"; // фоновый процесс пропал, например, после перезагрузки
	free(state);
	char *log = read_file(VPS "/log", &len);
	int running = strcmp(st, "running") == 0;

	// только целые строки: последняя без перевода строки ещё дописывается
	long total = 0;
	for (size_t i = 0; log && i < len; i++) total += log[i] == '\n';
	if (log && !running && len && log[len - 1] != '\n') total++;
	long until = total < from + STATUS_LINES ? total : from + STATUS_LINES;
	printf("@@state %s %ld %ld\n", st, until > from ? until : from, total);

	long line = 0;
	for (char *p = log; log && p < log + len && line < until; line++) {
		char *end = memchr(p, '\n', (size_t)(log + len - p));
		size_t n = end ? (size_t)(end - p) : (size_t)(log + len - p);
		if (line >= from) print_clean_line(p, n);
		p += n + 1;
	}
	free(log);
	return 0;
}

static int cmd_vps_cancel(void) {
	pid_t pid = vps_job_pid();
	if (pid) kill(pid, SIGTERM);
	puts(pid ? "cancelling" : "idle");
	return 0;
}

static int cmd_vps_clear(void) {
	if (vps_job_pid()) {
		say(LOG_WARNING, "vps: настройка ещё идёт");
		return 1;
	}
	static const char *const files[] = {"log", "state", "stdin", "pad", "pid", "home/.ssh/known_hosts"};
	char path[128];
	for (size_t i = 0; i < sizeof files / sizeof *files; i++) {
		snprintf(path, sizeof path, "%s/%s", VPS, files[i]);
		unlink(path);
	}
	rmdir(VPS "/home/.ssh");
	rmdir(VPS "/home");
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

/* start/stop/restart/status — от rc.unslung Entware, от initrc из архива и от прошивки через /opt/bin/sh */
static int run_action(const char *action) {
	if (strcmp(action, "start") == 0) return cmd_start();
	if (strcmp(action, "stop") == 0 || strcmp(action, "kill") == 0) return cmd_stop();
	if (strcmp(action, "restart") == 0) {
		cmd_stop();
		return cmd_start();
	}
	if (strcmp(action, "status") == 0 || strcmp(action, "check") == 0) return cmd_status();
	return -1;
}

/* Программа, вызванная как /opt/bin/sh (ссылка из архива, см. restore_entware_sh).
 * С Entware — передаём всё его busybox: он выберет ash по argv[0] («sh» или «-sh» у входа по SSH).
 * Без Entware настоящей оболочки на роутере нет, и прошивка зовёт нас только так:
 * «sh /opt/etc/initrc start|stop», а обёртка /bin/sh для нашего S99 — «sh …/S99hostsgen-ui start|stop».
 * Это и выполняем; чужие скрипты (например, хуки из /opt/etc/ndm/) исполнять нечем — пропускаем. */
static int sh_mode(int argc, char **argv) {
	if (access(ENTWARE_BUSYBOX, X_OK) == 0) {
		restore_entware_sh();
		execv(ENTWARE_BUSYBOX, argv);
		fprintf(stderr, "hostsgen-ui: не удалось запустить %s: %s\n", ENTWARE_BUSYBOX, strerror(errno));
		return 127;
	}
	const char *script = argc > 1 ? argv[1] : "", *action = argc > 2 ? argv[2] : "start";
	char line[256];
	if (strcmp(script, "-c") == 0 && argc > 2) { // та же команда строкой: «sh -c "/opt/etc/initrc start"»
		snprintf(line, sizeof line, "%s", argv[2]);
		char *space = strchr(line, ' ');
		action = "start";
		if (space) {
			*space = 0;
			for (action = space + 1; *action == ' '; action++) {
			}
		}
		script = line;
	}
	const char *base = strrchr(script, '/');
	base = base ? base + 1 : script;
	if (strcmp(base, "initrc") == 0 || strcmp(base, "S99hostsgen-ui") == 0) {
		int rc = run_action(*action ? action : "start");
		return rc < 0 ? 0 : rc;
	}
	if (script[0] == '/') return 0;
	fprintf(stderr, "hostsgen-ui: на накопителе нет оболочки — для скриптов установите Entware\n");
	return 127;
}

int main(int argc, char **argv) {
	const char *cmd = argc > 1 ? argv[1] : "";
	const char *name = strrchr(argv[0], '/');
	name = name ? name + 1 : argv[0];
	load_timezone();
	if (strcmp(name, "sh") == 0 || strcmp(name, "-sh") == 0) return sh_mode(argc, argv);
	int rc = run_action(cmd);
	if (rc >= 0) return rc;
	if (strcmp(cmd, "resolve") == 0) return cmd_resolve(argc - 2, argv + 2);
	if (strcmp(cmd, "vps-pad") == 0) return cmd_vps_pad();
	if (strcmp(cmd, "vps-start") == 0) return cmd_vps_start(argc - 2, argv + 2);
	if (strcmp(cmd, "vps-status") == 0) return cmd_vps_status(argc - 2, argv + 2);
	if (strcmp(cmd, "vps-cancel") == 0) return cmd_vps_cancel();
	if (strcmp(cmd, "vps-clear") == 0) return cmd_vps_clear();
	if (strcmp(cmd, "version") == 0) {
		puts(VERSION);
		return 0;
	}
	fprintf(stderr, "Использование: %s {start|stop|restart|status|resolve ДОМЕНЫ|vps-…|version}\n", argv[0]);
	return 2;
}
