package kg.verdict;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Set;
import kg.core.Hashing;

/**
 * Ed25519 signing keys from the Java runtime. The private key lives outside every project
 * folder with owner-only permissions; the project pins the public key's fingerprint.
 */
public final class Keys {
    private Keys() {
    }

    /** KINDGLEAM_KEYS (absolute path) if set, for example a hardware-token mount; else ~/.kindgleam/keys. */
    public static Path defaultDir() {
        String env = System.getenv("KINDGLEAM_KEYS");
        if (env != null && !env.isBlank() && Path.of(env).isAbsolute()) {
            return Path.of(env).normalize();
        }
        return Path.of(System.getProperty("user.home"), ".kindgleam", "keys");
    }

    public static KeyPair generate(Path dir) throws IOException, GeneralSecurityException {
        Path priv = dir.resolve("ledger_ed25519.key");
        if (Files.exists(priv)) {
            throw new IOException("key already exists, refusing to overwrite: " + priv);
        }
        KeyPair kp = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        Files.createDirectories(dir);
        try {
            Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------"));
        } catch (UnsupportedOperationException e) {
            // Non-POSIX file system (Windows): protected by the user profile ACL instead.
        }
        Files.write(priv, kp.getPrivate().getEncoded());
        try {
            Files.setPosixFilePermissions(priv, Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
        } catch (UnsupportedOperationException e) {
            // see above
        }
        Files.write(dir.resolve("ledger_ed25519.pub"), kp.getPublic().getEncoded());
        return kp;
    }

    public static PrivateKey loadPrivate(Path dir) throws IOException, GeneralSecurityException {
        Path p = dir.resolve("ledger_ed25519.key");
        if (Files.isSymbolicLink(p)) {
            throw new IOException("private key must not be a symbolic link");
        }
        try {
            Set<PosixFilePermission> perms = Files.getPosixFilePermissions(p);
            if (perms.contains(PosixFilePermission.GROUP_READ) || perms.contains(PosixFilePermission.OTHERS_READ)) {
                throw new IOException("private key is readable by other users: " + p);
            }
        } catch (UnsupportedOperationException e) {
            // Non-POSIX file system.
        }
        return KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(Files.readAllBytes(p)));
    }

    public static PublicKey loadPublic(Path dir) throws IOException, GeneralSecurityException {
        return KeyFactory.getInstance("Ed25519")
                .generatePublic(new X509EncodedKeySpec(Files.readAllBytes(dir.resolve("ledger_ed25519.pub"))));
    }

    public static String fingerprint(PublicKey k) {
        return Hashing.sha256(k.getEncoded());
    }

    public static byte[] sign(PrivateKey k, byte[] data) throws GeneralSecurityException {
        Signature s = Signature.getInstance("Ed25519");
        s.initSign(k);
        s.update(data);
        return s.sign();
    }

    public static boolean verify(PublicKey k, byte[] data, byte[] sig) throws GeneralSecurityException {
        Signature s = Signature.getInstance("Ed25519");
        s.initVerify(k);
        s.update(data);
        return s.verify(sig);
    }
}
