<?php
/**
 * Plugin Name: Comment Desk (staging only, hidden)
 * Description: The dev-comments Comment Desk on the staging site, for working from a phone. Install as a mu-plugin next to dev-comments.php.
 *
 * Hidden on purpose:
 * - Served only under a long random path (config "slug"); every other request is left to WordPress. The path is
 *   linked from nowhere and listed nowhere (not in robots.txt, not in a sitemap).
 * - Locks: the site's HTTP basic auth (its password is factor one), only the logins in "logins" (not the client), then a
 *   code from an authenticator app (TOTP, each code once; factor two), a signed cookie for 7 days. Ten failures in
 *   an hour shut the form for that hour. No second password: the staging login is factor one.
 *   Claude's tools on the Mac use a token header instead.
 * - A message typed here for Claude is HELD: the Mac asks the owner on Telegram for a one-time code and only acts on
 *   what they confirmed there. The Mac keeps its own list of what it may act on, so nothing written into this store
 *   (by the page or by anyone who got into the hosting) can make Claude act by itself (desk.mjs, `wait`).
 * - Every response: noindex/nofollow, no referrer, no caching, no framing; a neutral page title.
 *
 * It is also the SHARED STORE of the desk: workbench chat, Claude's notes, the feed and pasted images live here
 * (outside the web's reach), so the desk on the Mac (desk.mjs, "remote" in .comment-desk.local.json) and this page
 * show the same thing. the client's comments are the dev-comments store next to it (dev-comments.php).
 *
 * Config (created by comment-desk-setup.sh, never in git): <staging root>/.comment-desk/config.json
 *   { "slug": "k7q2…", "totp": "<base32>", "secret": "…", "token": "…", "logins": ["noor"],
 *     "me": "Noor", "project": "…", "audience": "Tobias", "label": "Tobias · staging", "room": "…" }
 *
 * Routes, all under /<slug>/:
 *   GET  ''                         the page (desk.html next to this file), or the code form
 *   POST login                      { code } → cookie
 *   GET  api/state                  what the page needs (sources, the client's comments, notes, chat, feed)
 *   POST api/comment/staging/<id>   { action: resolve|reopen|reply, text } on the client's comment (signed "me")
 *   POST api/chat/<src>/<id>        { text, images: [data URL], by? } a workbench message (by: token only)
 *   GET  api/desk                   notes, chat, feed (Claude's tools)
 *   POST api/desk/note|feed|seen|shot    Claude's tools: a card's note, a feed line, "Claude is on it", a screenshot
 *   GET  upload/<file>, shot/staging/<id>[/before]
 */

if ( ! defined( 'WP_ENVIRONMENT_TYPE' ) || WP_ENVIRONMENT_TYPE !== 'staging' ) {
	return;
}

const DC_DESK_DIR = ABSPATH . '.comment-desk';

function dc_desk_config() {
	static $c = null;
	if ( null === $c ) {
		$c = json_decode( (string) @file_get_contents( DC_DESK_DIR . '/config.json' ), true ) ?: array();
	}
	return $c;
}

/** the request path under the slug ('' for the page), or null when the request is not for the desk */
function dc_desk_path() {
	$slug = dc_desk_config()['slug'] ?? '';
	if ( strlen( $slug ) < 16 ) {
		return null;   // not set up: the desk does not exist
	}
	$path = (string) parse_url( $_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH );
	$base = '/' . $slug;
	if ( $path === $base ) {
		return '';
	}
	return 0 === strpos( $path, $base . '/' ) ? substr( $path, strlen( $base ) + 1 ) : null;
}

function dc_desk_login_user() {
	$user = $_SERVER['PHP_AUTH_USER'] ?? $_SERVER['REMOTE_USER'] ?? $_SERVER['REDIRECT_REMOTE_USER'] ?? '';
	if ( '' === $user ) {
		$h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
		if ( 0 === stripos( $h, 'Basic ' ) ) {
			$user = strstr( (string) base64_decode( substr( $h, 6 ) ), ':', true );
		}
	}
	return strtolower( (string) $user );
}

function dc_desk_headers( $type = 'application/json' ) {
	header( 'Content-Type: ' . $type );
	header( 'X-Robots-Tag: noindex, nofollow, noarchive, nosnippet' );
	header( 'Referrer-Policy: no-referrer' );
	header( 'Cache-Control: no-store, private' );
	header( 'X-Frame-Options: DENY' );
	header( 'X-Content-Type-Options: nosniff' );
}
function dc_desk_json( $data, $code = 200 ) {
	status_header( $code );
	dc_desk_headers();
	echo wp_json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
	exit;
}
function dc_desk_404() {
	status_header( 404 );
	dc_desk_headers( 'text/plain; charset=utf-8' );
	echo 'Not found';
	exit;
}
function dc_desk_body() {
	$b = json_decode( (string) file_get_contents( 'php://input' ), true );
	return is_array( $b ) ? $b : array();
}

// ---------- the desk's own lock: an authenticator code, a signed cookie, a slow and capped check
function dc_desk_cookie_ok() {
	$v = $_COOKIE['cd_s'] ?? '';
	if ( ! preg_match( '/^(\d+)\.([a-f0-9]{64})$/', $v, $m ) || (int) $m[1] < time() ) {
		return false;
	}
	return hash_equals( hash_hmac( 'sha256', $m[1], dc_desk_config()['secret'] ?? '' ), $m[2] );
}
function dc_desk_token_ok() {
	$t = $_SERVER['HTTP_X_DESK_TOKEN'] ?? '';
	$k = dc_desk_config()['token'] ?? '';
	return strlen( $k ) >= 32 && is_string( $t ) && hash_equals( $k, $t );
}
/** RFC 6238 (SHA-1, 6 digits, 30 s); accepts the step before and after, and each step only once */
function dc_desk_totp_step( $code ) {
	$b32 = strtoupper( (string) ( dc_desk_config()['totp'] ?? '' ) );
	if ( strlen( $b32 ) < 16 || ! preg_match( '/^\d{6}$/', (string) $code ) ) {
		return false;
	}
	$bits = '';
	foreach ( str_split( $b32 ) as $ch ) {
		$v = strpos( 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', $ch );
		if ( false === $v ) {
			return false;
		}
		$bits .= str_pad( decbin( $v ), 5, '0', STR_PAD_LEFT );
	}
	$key = '';
	foreach ( str_split( substr( $bits, 0, strlen( $bits ) - strlen( $bits ) % 8 ), 8 ) as $byte ) {
		$key .= chr( bindec( $byte ) );
	}
	$now = intdiv( time(), 30 );
	foreach ( array( $now - 1, $now, $now + 1 ) as $step ) {
		$h   = hash_hmac( 'sha1', pack( 'N2', 0, $step ), $key, true );
		$o   = ord( $h[19] ) & 0xf;
		$otp = ( ( ( ord( $h[ $o ] ) & 0x7f ) << 24 ) | ( ord( $h[ $o + 1 ] ) << 16 ) | ( ord( $h[ $o + 2 ] ) << 8 ) | ord( $h[ $o + 3 ] ) ) % 1000000;
		if ( hash_equals( str_pad( (string) $otp, 6, '0', STR_PAD_LEFT ), (string) $code ) ) {
			return $step;
		}
	}
	return false;
}
function dc_desk_try_login( $code ) {
	$f     = DC_DESK_DIR . '/fails.json';
	$fails = array_filter( json_decode( (string) @file_get_contents( $f ), true ) ?: array(), function ( $t ) { return $t > time() - 3600; } );
	if ( count( $fails ) >= 10 ) {
		return 'locked';   // ten wrong codes in an hour: the form stays shut for the rest of that hour
	}
	$step = dc_desk_totp_step( $code );
	$used = (int) @file_get_contents( DC_DESK_DIR . '/totp-last' );
	if ( false !== $step && $step > $used ) {
		file_put_contents( DC_DESK_DIR . '/totp-last', (string) $step );   // this code can't be used again
		$exp = time() + 7 * 86400;
		setcookie( 'cd_s', $exp . '.' . hash_hmac( 'sha256', (string) $exp, dc_desk_config()['secret'] ), array( 'expires' => $exp, 'path' => '/' . dc_desk_config()['slug'], 'secure' => true, 'httponly' => true, 'samesite' => 'Strict' ) );
		@file_put_contents( $f, '[]' );
		return 'ok';
	}
	sleep( 1 );
	$fails[] = time();
	@file_put_contents( $f, wp_json_encode( array_values( $fails ) ) );
	return 'wrong';
}
function dc_desk_login_page( $note = '' ) {
	status_header( 200 );
	dc_desk_headers( 'text/html; charset=utf-8' );
	header( "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" );
	$msg = array( 'wrong' => 'That is not it.', 'locked' => 'Too many tries. Wait an hour.' )[ $note ] ?? '';
	echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Notes</title>'
		. '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111010;color:#efeae3;font:16px system-ui,sans-serif}form{display:flex;flex-direction:column;gap:12px;width:min(320px,86vw)}input{font:inherit;padding:12px 14px;border-radius:10px;border:1px solid #2e2b28;background:#191817;color:inherit}button{font:inherit;font-weight:600;padding:12px;border:0;border-radius:10px;background:#f98829;color:#1a1714}p{margin:0;color:#e0908c;font-size:14px}</style></head><body>'
		. '<form method="post" action="/' . esc_attr( dc_desk_config()['slug'] ) . '/login"><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="6-digit code" aria-label="Code from your authenticator app" autofocus required><button>Open</button>' . ( $msg ? '<p>' . esc_html( $msg ) . '</p>' : '' ) . '</form></body></html>';
	exit;
}

// ---------- the shared desk store (notes, chat, feed), under a lock
function dc_desk_state_read() {
	$s = json_decode( (string) @file_get_contents( DC_DESK_DIR . '/state.json' ), true );
	return array_merge( array( 'notes' => array(), 'feed' => array(), 'chat' => array(), 'nextMsg' => 1 ), is_array( $s ) ? $s : array() );
}
function dc_desk_state_update( $fn ) {
	$lock = fopen( DC_DESK_DIR . '/.lock', 'c' );
	flock( $lock, LOCK_EX );
	$s   = dc_desk_state_read();
	$out = $fn( $s );
	file_put_contents( DC_DESK_DIR . '/state.json.tmp', wp_json_encode( $s, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) . "\n" );
	rename( DC_DESK_DIR . '/state.json.tmp', DC_DESK_DIR . '/state.json' );
	flock( $lock, LOCK_UN );
	fclose( $lock );
	return $out;
}
function dc_desk_now() {
	return gmdate( 'Y-m-d\TH:i:s' ) . '.' . sprintf( '%03d', (int) ( microtime( true ) * 1000 ) % 1000 ) . 'Z';
}
function dc_desk_add_message( &$s, $src, $id, $by, $text, $images, $held = false ) {
	$k = $src . ':' . (int) $id;
	$m = array( 'id' => $s['nextMsg']++, 'by' => $by, 'text' => mb_substr( (string) $text, 0, 8000 ), 'images' => $images, 'at' => dc_desk_now() );
	if ( 'Claude' !== $by ) {
		$m['status'] = $held ? 'held' : 'new';   // held: typed on this page, waiting for the owner's OK on Telegram
		$s['notes'][ $src ][ (string) (int) $id ] = array_merge( $s['notes'][ $src ][ (string) (int) $id ] ?? array(), array( 'lane' => 'claude', 'at' => $m['at'] ) );
	} else {
		foreach ( $s['chat'][ $k ] ?? array() as $i => $x ) {
			if ( 'Claude' !== $x['by'] && ( $x['status'] ?? '' ) !== 'answered' ) {
				$s['chat'][ $k ][ $i ]['status'] = 'answered';
			}
		}
	}
	$s['chat'][ $k ][] = $m;
	return $m;
}
/** pasted images arrive as data: URLs; they are stored as files next to the state */
function dc_desk_save_images( $list, $dir = 'uploads' ) {
	$out = array();
	foreach ( array_slice( is_array( $list ) ? $list : array(), 0, 8 ) as $d ) {
		if ( ! preg_match( '#^data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$#', (string) $d, $m ) ) {
			continue;
		}
		$bin = base64_decode( $m[2], true );
		if ( false === $bin || strlen( $bin ) > 12 * 1024 * 1024 ) {
			continue;
		}
		wp_mkdir_p( DC_DESK_DIR . '/' . $dir );
		$name = base_convert( (string) time(), 10, 36 ) . '-' . bin2hex( random_bytes( 4 ) ) . '.' . ( 'jpeg' === $m[1] ? 'jpg' : $m[1] );
		file_put_contents( DC_DESK_DIR . '/' . $dir . '/' . $name, $bin );
		$out[] = $name;
	}
	return $out;
}
function dc_desk_send_file( $f ) {
	if ( ! is_file( $f ) ) {
		dc_desk_404();
	}
	$types = array( 'png' => 'image/png', 'jpg' => 'image/jpeg', 'webp' => 'image/webp', 'gif' => 'image/gif' );
	dc_desk_headers( $types[ strtolower( pathinfo( $f, PATHINFO_EXTENSION ) ) ] ?? 'application/octet-stream' );
	readfile( $f );
	exit;
}

// ---------- the router
function dc_desk_handle() {
	$p = dc_desk_path();
	if ( null === $p ) {
		return;   // not ours: WordPress carries on
	}
	$cfg = dc_desk_config();
	if ( ! in_array( dc_desk_login_user(), $cfg['logins'] ?? array(), true ) ) {
		dc_desk_404();   // another staging login (the client): the desk does not exist for it
	}
	$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
	$tool   = dc_desk_token_ok();
	if ( 'login' === $p && 'POST' === $method ) {
		$r = dc_desk_try_login( preg_replace( '/\s+/', '', (string) ( $_POST['code'] ?? '' ) ) );
		if ( 'ok' === $r ) {
			wp_safe_redirect( '/' . $cfg['slug'] . '/', 303 );
			exit;
		}
		dc_desk_login_page( $r );
	}
	if ( 'POST' === $method && 'login' !== $p ) {   // changes come as JSON, and from this site when the browser says where from
		$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
		if ( ! preg_match( '#^application/json\b#i', $_SERVER['CONTENT_TYPE'] ?? '' ) || ( '' !== $origin && rtrim( $origin, '/' ) !== rtrim( home_url(), '/' ) ) ) {
			dc_desk_json( array( 'error' => 'Refused.' ), 403 );
		}
	}
	if ( ! $tool && ! dc_desk_cookie_ok() ) {
		if ( '' === $p ) {
			dc_desk_login_page();
		}
		dc_desk_json( array( 'error' => 'Log in again.' ), 401 );
	}

	if ( '' === $p ) {
		$html = (string) @file_get_contents( __DIR__ . '/comment-desk/desk.html' );
		$nonce = base64_encode( random_bytes( 16 ) );   // only the page's own scripts run; nothing smuggled into a comment can
		$html  = str_replace( '<title>Comment Desk</title>', '<title>Notes</title><meta name="robots" content="noindex,nofollow"><script>window.DESK_BASE = ' . wp_json_encode( '/' . $cfg['slug'] ) . ';</script>', $html );
		$html  = str_replace( '<script>', '<script nonce="' . $nonce . '">', $html );
		status_header( 200 );
		dc_desk_headers( 'text/html; charset=utf-8' );
		header( "Content-Security-Policy: default-src 'none'; script-src 'nonce-" . $nonce . "'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" );
		echo $html;
		exit;
	}

	if ( 'api/state' === $p ) {
		$st       = dc_desk_state_read();
		$comments = dc_read()['comments'];
		foreach ( $comments as &$c ) {
			$c['shots'] = array( 'now' => is_file( DC_DESK_DIR . '/shots/' . (int) $c['id'] . '.png' ), 'before' => is_file( DC_DESK_DIR . '/shots/before/' . (int) $c['id'] . '.png' ) );
		}
		unset( $c );
		dc_desk_json( array(
			'me'       => $cfg['me'] ?? 'you',
			'project'  => $cfg['project'] ?? 'Desk',
			'sources'  => array( array( 'id' => 'staging', 'label' => $cfg['label'] ?? 'staging', 'audience' => $cfg['audience'] ?? null, 'site' => home_url(), 'room' => $cfg['room'] ?? '' ) ),
			'comments' => array( 'staging' => $comments ),
			'notes'    => $st['notes'],
			'chat'     => $st['chat'],
			'feed'     => array_reverse( array_slice( $st['feed'], -40 ) ),
			'errors'   => array(),
		) );
	}

	if ( preg_match( '#^api/comment/staging/(\d+)$#', $p, $m ) && 'POST' === $method ) {
		$b    = dc_desk_body();
		$text = trim( (string) ( $b['text'] ?? '' ) );
		$ch   = 'resolve' === ( $b['action'] ?? '' ) ? array( 'status' => 'resolved' ) : ( 'reopen' === ( $b['action'] ?? '' ) ? array( 'status' => 'open' ) : ( 'reply' === ( $b['action'] ?? '' ) && '' !== $text ? array( 'reply' => array( 'by' => $cfg['me'] ?? 'you', 'text' => $text ) ) : null ) );
		if ( ! $ch ) {
			dc_desk_json( array( 'error' => 'Unknown action, or an empty reply.' ), 400 );
		}
		$c = dc_update( function ( &$db ) use ( $m, $ch ) { return dc_patch( $db, $m[1], $ch ); } );
		$c ? dc_desk_json( $c ) : dc_desk_json( array( 'error' => 'No such comment.' ), 404 );
	}

	if ( preg_match( '#^api/chat/([\w-]+)/(\d+)$#', $p, $m ) && 'POST' === $method ) {
		$b      = dc_desk_body();
		$text   = trim( (string) ( $b['text'] ?? '' ) );
		$images = dc_desk_save_images( $b['images'] ?? array() );
		if ( '' === $text && ! $images ) {
			dc_desk_json( array( 'error' => 'Write something or paste a screenshot.' ), 400 );
		}
		$by = $tool && in_array( $b['by'] ?? '', array( 'Claude', $cfg['me'] ?? '' ), true ) ? $b['by'] : ( $cfg['me'] ?? 'you' );
		$held = ! $tool;
		dc_desk_json( dc_desk_state_update( function ( &$s ) use ( $m, $by, $text, $images, $held ) { return dc_desk_add_message( $s, $m[1], $m[2], $by, $text, $images, $held ); } ) );
	}

	if ( 0 === strpos( $p, 'api/desk' ) ) {
		if ( ! $tool ) {
			dc_desk_json( array( 'error' => 'Tools only.' ), 403 );
		}
		if ( 'api/desk' === $p ) {
			dc_desk_json( dc_desk_state_read() );
		}
		$b = dc_desk_body();
		if ( 'api/desk/note' === $p && 'POST' === $method ) {
			dc_desk_json( dc_desk_state_update( function ( &$s ) use ( $b ) {
				$src = preg_replace( '/[^\w-]/', '', (string) ( $b['src'] ?? '' ) );
				$id  = (string) (int) ( $b['id'] ?? 0 );
				if ( ! empty( $b['clear'] ) ) {
					unset( $s['notes'][ $src ][ $id ] );
					return array( 'ok' => true );
				}
				$s['notes'][ $src ][ $id ] = array_merge( $s['notes'][ $src ][ $id ] ?? array(), array_filter( array( 'lane' => (string) ( $b['lane'] ?? '' ), 'text' => isset( $b['text'] ) ? (string) $b['text'] : null, 'at' => dc_desk_now() ), function ( $v ) { return null !== $v && '' !== $v; } ) );
				if ( ! empty( $b['answer'] ) ) {   // a new status answers what the owner said on that card (same as desk.mjs)
					foreach ( $s['chat'][ $src . ':' . $id ] ?? array() as $i => $x ) {
						if ( 'Claude' !== $x['by'] && ( $x['status'] ?? '' ) !== 'answered' ) {
							$s['chat'][ $src . ':' . $id ][ $i ]['status'] = 'answered';
						}
					}
				}
				return $s['notes'][ $src ][ $id ];
			} ) );
		}
		if ( 'api/desk/feed' === $p && 'POST' === $method ) {
			dc_desk_json( dc_desk_state_update( function ( &$s ) use ( $b ) {
				foreach ( (array) ( $b['lines'] ?? array( $b['text'] ?? '' ) ) as $t ) {
					if ( '' !== trim( (string) $t ) ) {
						$s['feed'][] = array( 'at' => dc_desk_now(), 'text' => mb_substr( (string) $t, 0, 1000 ) );
					}
				}
				$s['feed'] = array_slice( $s['feed'], -200 );
				return array( 'ok' => true );
			} ) );
		}
		if ( 'api/desk/seen' === $p && 'POST' === $method ) {   // the Mac chose what it acts on: show "Claude is on it"
			$ids = array_map( 'intval', (array) ( $b['ids'] ?? array() ) );
			dc_desk_json( dc_desk_state_update( function ( &$s ) use ( $ids ) {
				foreach ( $s['chat'] as $k => $msgs ) {
					foreach ( $msgs as $i => $x ) {
						if ( in_array( (int) $x['id'], $ids, true ) && 'Claude' !== $x['by'] && 'answered' !== ( $x['status'] ?? '' ) ) {
							$s['chat'][ $k ][ $i ]['status'] = 'seen';
						}
					}
				}
				return array( 'ok' => true );
			} ) );
		}
		if ( 'api/desk/shot' === $p && 'POST' === $method ) {
			$id   = (int) ( $b['id'] ?? 0 );
			$dir  = DC_DESK_DIR . '/shots' . ( ! empty( $b['before'] ) ? '/before' : '' );
			$data = preg_match( '#^data:image/png;base64,([A-Za-z0-9+/=]+)$#', (string) ( $b['data'] ?? '' ), $mm ) ? base64_decode( $mm[1], true ) : false;
			if ( ! $id || ! $data ) {
				dc_desk_json( array( 'error' => 'id and a PNG data URL' ), 400 );
			}
			wp_mkdir_p( $dir );
			file_put_contents( $dir . '/' . $id . '.png', $data );
			dc_desk_json( array( 'ok' => true ) );
		}
		dc_desk_404();
	}

	if ( preg_match( '#^upload/([\w.-]+)$#', $p, $m ) ) {
		dc_desk_send_file( DC_DESK_DIR . '/uploads/' . $m[1] );
	}
	if ( preg_match( '#^shot/staging/(\d+)(/before)?$#', $p, $m ) ) {
		dc_desk_send_file( DC_DESK_DIR . '/shots/' . ( ! empty( $m[2] ) ? 'before/' : '' ) . (int) $m[1] . '.png' );
	}
	dc_desk_404();
}
add_action( 'plugins_loaded', 'dc_desk_handle', 0 );
