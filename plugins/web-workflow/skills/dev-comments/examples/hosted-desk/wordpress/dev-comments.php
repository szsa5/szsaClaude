<?php
/**
 * Plugin Name: Dev comments (staging only)
 * Description: Click-to-comment overlay for the staging site + the JSON endpoint behind it. Does nothing unless
 *              WP_ENVIRONMENT_TYPE is "staging". Install as a mu-plugin on the staging site.
 *
 * Mirrors the reference implementation of the dev-comments skill (store.mjs + index.mjs) in PHP:
 *   GET    /wp-json/dev-comments/v1/comments        -> { next, comments[] }
 *   POST   /wp-json/dev-comments/v1/comments        -> create (body: the capture + text)
 *   PATCH  /wp-json/dev-comments/v1/comments/<id>   -> { text? , reply?: {by,text}, status?: open|resolved }
 *   DELETE /wp-json/dev-comments/v1/comments/<id>
 *   GET    /wp-json/dev-comments/v1/me              -> { author } (for the static pages' overlay)
 * The file lives at <staging root>/.dev-comments/comments.json (web access denied); the CLI on the Mac
 * syncs it over SSH and sends replies through this endpoint, so there is one writer at a time (flock).
 */

if ( ! defined( 'WP_ENVIRONMENT_TYPE' ) || WP_ENVIRONMENT_TYPE !== 'staging' ) {
	return;
}

const DC_DIR  = ABSPATH . '.dev-comments';
const DC_FILE = DC_DIR . '/comments.json';

/** Who is logged in (staging's HTTP basic auth) -> the name comments are signed with. */
function dc_author() {
	$user = $_SERVER['PHP_AUTH_USER'] ?? $_SERVER['REMOTE_USER'] ?? $_SERVER['REDIRECT_REMOTE_USER'] ?? '';
	if ( '' === $user ) {
		$h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
		if ( 0 === stripos( $h, 'Basic ' ) ) {
			$user = strstr( (string) base64_decode( substr( $h, 6 ) ), ':', true );
		}
	}
	$names = array( 'noor' => 'Noor', 'tobias' => 'Tobias', 'claude-cli' => 'Claude' );   // login => display name; claude-cli = the CLI's own login (example names)
	$user  = strtolower( (string) $user );
	return $names[ $user ] ?? ( $user !== '' ? $user : 'you' );
}

// What the browser may set when it creates a comment; everything else is decided here (same list as store.mjs).
const DC_CREATE_FIELDS = array( 'page', 'url', 'text', 'selector', 'fx', 'fy', 'docX', 'docY', 'viewport', 'html', 'element', 'trail', 'storage', 'userAgent' );

function dc_now() {
	return gmdate( 'Y-m-d\TH:i:s' ) . '.' . sprintf( '%03d', (int) ( microtime( true ) * 1000 ) % 1000 ) . 'Z';
}

function dc_read() {
	$db = json_decode( @file_get_contents( DC_FILE ), true );
	return array(
		'next'     => isset( $db['next'] ) ? (int) $db['next'] : 1,
		'comments' => isset( $db['comments'] ) && is_array( $db['comments'] ) ? array_values( $db['comments'] ) : array(),
	);
}

function dc_write( $db ) {
	if ( ! is_dir( DC_DIR ) ) {
		mkdir( DC_DIR, 0755, true );
		file_put_contents( DC_DIR . '/.htaccess', "Require all denied\n" );
		file_put_contents( DC_DIR . '/index.php', "<?php // silence\n" );
	}
	$tmp = DC_FILE . '.tmp';
	file_put_contents( $tmp, json_encode( $db, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) . "\n" );
	rename( $tmp, DC_FILE );
}

/** read, change, write under a lock; $fn gets &$db and may return a value */
function dc_update( $fn ) {
	if ( ! is_dir( DC_DIR ) ) {
		dc_write( array( 'next' => 1, 'comments' => array() ) );
	}
	$lock = fopen( DC_DIR . '/.lock', 'c' );
	flock( $lock, LOCK_EX );
	$db  = dc_read();
	$out = $fn( $db );
	dc_write( $db );
	flock( $lock, LOCK_UN );
	fclose( $lock );
	return $out;
}

function dc_create( &$db, $body ) {
	$c = array( 'id' => $db['next']++, 'status' => 'open', 'author' => dc_author(), 'createdAt' => dc_now() );
	foreach ( DC_CREATE_FIELDS as $k ) {
		if ( isset( $body[ $k ] ) ) {
			$c[ $k ] = $body[ $k ];
		}
	}
	$c['text']    = mb_substr( (string) ( $c['text'] ?? '' ), 0, 4000 );
	$c['replies'] = array();
	$db['comments'][] = $c;
	return $c;
}

function dc_patch( &$db, $id, $body ) {
	foreach ( $db['comments'] as &$c ) {
		if ( (int) $c['id'] !== (int) $id ) {
			continue;
		}
		if ( isset( $body['text'] ) ) {
			$c['text'] = mb_substr( (string) $body['text'], 0, 4000 );
		}
		if ( ! empty( $body['reply'] ) && trim( (string) ( $body['reply']['text'] ?? '' ) ) !== '' ) {
			$c['replies'][] = array( 'by' => (string) ( $body['reply']['by'] ?? 'you' ), 'text' => mb_substr( (string) $body['reply']['text'], 0, 4000 ), 'at' => dc_now() );
		}
		if ( isset( $body['status'] ) && in_array( $body['status'], array( 'open', 'resolved' ), true ) ) {
			$c['status'] = $body['status'];
			$c[ 'resolved' === $body['status'] ? 'resolvedAt' : 'reopenedAt' ] = dc_now();
		}
		$c['updatedAt'] = dc_now();
		return $c;
	}
	return null;
}

function dc_delete( &$db, $id ) {
	foreach ( $db['comments'] as $i => $c ) {
		if ( (int) $c['id'] === (int) $id ) {
			array_splice( $db['comments'], $i, 1 );
			return true;
		}
	}
	return false;
}

add_action( 'rest_api_init', function () {
	$json = function ( $data, $code = 200 ) {
		nocache_headers();
		return new WP_REST_Response( $data, $code );
	};
	register_rest_route( 'dev-comments/v1', '/comments', array(
		array(
			'methods'             => 'GET',
			'permission_callback' => '__return_true',   // staging sits behind HTTP basic auth
			'callback'            => function () use ( $json ) {
				return $json( dc_read() );
			},
		),
		array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => function ( WP_REST_Request $r ) use ( $json ) {
				$b = $r->get_json_params() ?: array();
				if ( trim( (string) ( $b['text'] ?? '' ) ) === '' ) {
					return $json( array( 'error' => 'text is required' ), 400 );
				}
				return $json( dc_update( function ( &$db ) use ( $b ) { return dc_create( $db, $b ); } ), 201 );
			},
		),
	) );
	// who is logged in: the static (Astro) pages on staging ask this before mounting the overlay
	register_rest_route( 'dev-comments/v1', '/me', array(
		'methods'             => 'GET',
		'permission_callback' => '__return_true',
		'callback'            => function () use ( $json ) {
			return $json( array( 'author' => dc_author() ) );
		},
	) );
	register_rest_route( 'dev-comments/v1', '/comments/(?P<id>\d+)', array(
		array(
			'methods'             => 'PATCH',
			'permission_callback' => '__return_true',
			'callback'            => function ( WP_REST_Request $r ) use ( $json ) {
				$b = $r->get_json_params() ?: array();
				$c = dc_update( function ( &$db ) use ( $r, $b ) { return dc_patch( $db, $r['id'], $b ); } );
				return $c ? $json( $c ) : $json( array( 'error' => 'no such comment' ), 404 );
			},
		),
		array(
			'methods'             => 'DELETE',
			'permission_callback' => '__return_true',
			'callback'            => function ( WP_REST_Request $r ) use ( $json ) {
				$ok = dc_update( function ( &$db ) use ( $r ) { return dc_delete( $db, $r['id'] ); } );
				return $ok ? $json( array( 'ok' => true ) ) : $json( array( 'error' => 'no such comment' ), 404 );
			},
		),
	) );
} );

// /?logout — browsers keep a basic-auth login until they get a 401 for it. First visit: answer 401 (and set a
// cookie), so the browser forgets the login and asks again. When the browser retries with what was typed, Apache
// has already accepted it; we see the cookie, clear it and send the person to the home page as the new user.
// Cancel on the prompt = stays logged out.
add_action( 'init', function () {
	if ( ! isset( $_GET['logout'] ) ) {
		return;
	}
	if ( ! empty( $_COOKIE['dc_logout'] ) ) {
		setcookie( 'dc_logout', '', time() - 3600, '/' );
		wp_redirect( home_url( '/' ), 302 );
		exit;
	}
	setcookie( 'dc_logout', '1', 0, '/' );
	header( 'WWW-Authenticate: Basic realm="Staging"' );
	header( 'Cache-Control: no-store' );
	status_header( 401 );
	echo '<!doctype html><meta charset="utf-8"><title>Logged out</title><body style="font:16px system-ui;padding:40px"><p>You are logged out of staging. <a href="/">Log in again</a> as someone else.</p>';
	exit;
} );

// The overlay, on every front-end page (not in wp-admin, not inside the Elementor editor/preview).
add_action( 'wp_footer', function () {
	if ( 'book' === trim( (string) wp_parse_url( $_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH ), '/' ) ) {
		return;   // the booking form inside the static site's dialog: the page around it already has the overlay
	}
	if ( is_admin() || isset( $_GET['elementor-preview'] ) || ( class_exists( '\Elementor\Plugin' ) && \Elementor\Plugin::$instance->editor->is_edit_mode() ) ) {
		return;
	}
	$client = content_url( 'mu-plugins/dev-comments/client.js' ) . '?v=' . filemtime( WPMU_PLUGIN_DIR . '/dev-comments/client.js' );
	$opts   = array(
		'route'           => rest_url( 'dev-comments/v1/comments' ),
		'author'          => dc_author(),
		'accent'          => '#2f7cff',           // the site is black/white/orange: blue never blends in
		'side'            => 'left',              // the reCAPTCHA badge owns bottom-right
		'bottom'          => 20,
		'bottomMobile'    => 20,
		'storagePrefixes' => array( 'hg-' ),      // only our own keys; Elementor's localStorage stays out of the file
	);
	echo '<script type="module">import { mount } from ' . wp_json_encode( $client ) . '; mount(' . wp_json_encode( $opts ) . ');</script>' . "\n";
}, 99 );
