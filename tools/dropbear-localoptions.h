/* Настройки сборки SSH-клиента dropbear (dbclient) для «VPN на своём сервере» — build.sh.
 * Клиенту нужен только вход по паролю и выполнение команды; пересылки портов, агент и прокси
 * выключены — меньше кода и меньше поверхность атаки. Шифры и обмен ключами — по умолчанию dropbear,
 * включая постквантовые sntrup761 и mlkem768. */
#define DROPBEAR_CLI_LOCALTCPFWD 0
#define DROPBEAR_CLI_REMOTETCPFWD 0
#define DROPBEAR_CLI_AGENTFWD 0
#define DROPBEAR_CLI_PROXYCMD 0
#define DROPBEAR_CLI_NETCAT 0
#define DROPBEAR_SK_KEYS 0
