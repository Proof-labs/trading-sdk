//! HSM signing backend: an Ed25519 key resident in a PKCS#11 token.
//!
//! Implements the core [`Signer`] trait by delegating signing to the device —
//! the private key never enters this process. The PKCS#11 module (`.so`) is
//! loaded at runtime via `cryptoki`, so building this does not require any HSM
//! to be present.
//!
//! Scope: references a key that *already exists* in the token (by label); it
//! does not import or generate keys.

use std::sync::Mutex;

use cryptoki::context::{CInitializeArgs, CInitializeFlags, Pkcs11};
use cryptoki::mechanism::eddsa::{EddsaParams, EddsaSignatureScheme};
use cryptoki::mechanism::Mechanism;
use cryptoki::object::{Attribute, AttributeType, ObjectClass, ObjectHandle};
use cryptoki::session::{Session, UserType};
use cryptoki::types::AuthPin;

use core_sdk::{Signer, SignerError};

/// A signer backed by a private key resident in a PKCS#11 token.
pub struct Pkcs11Signer {
    // The library context must outlive the session.
    _ctx: Pkcs11,
    // PKCS#11 sessions are not guaranteed thread-safe; serialize access.
    session: Mutex<Session>,
    priv_handle: ObjectHandle,
    public_key: [u8; 32],
}

impl Pkcs11Signer {
    /// Open the token in `slot_id` from PKCS#11 `module`, log in with `pin`,
    /// and bind to the Ed25519 keypair labelled `label`.
    ///
    /// `pin` is used only for the login and is not retained.
    pub fn open(module: &str, slot_id: u64, pin: &str, label: &str) -> Result<Self, String> {
        let ctx = Pkcs11::new(module).map_err(|e| format!("load PKCS#11 module: {e}"))?;
        ctx.initialize(CInitializeArgs::new(CInitializeFlags::OS_LOCKING_OK))
            .map_err(|e| format!("initialize PKCS#11: {e}"))?;

        let slot = ctx
            .get_slots_with_token()
            .map_err(|e| format!("list slots: {e}"))?
            .into_iter()
            .find(|s| s.id() == slot_id)
            .ok_or_else(|| format!("no token found in slot {slot_id}"))?;

        let session = ctx
            .open_ro_session(slot)
            .map_err(|e| format!("open session: {e}"))?;
        session
            .login(UserType::User, Some(&AuthPin::new(pin.into())))
            .map_err(|e| format!("login failed: {e}"))?;

        let label_bytes = label.as_bytes().to_vec();

        let priv_handle = *session
            .find_objects(&[
                Attribute::Class(ObjectClass::PRIVATE_KEY),
                Attribute::Label(label_bytes.clone()),
            ])
            .map_err(|e| format!("find private key: {e}"))?
            .first()
            .ok_or_else(|| format!("no private key labelled {label:?}"))?;

        let pub_handle = *session
            .find_objects(&[
                Attribute::Class(ObjectClass::PUBLIC_KEY),
                Attribute::Label(label_bytes),
            ])
            .map_err(|e| format!("find public key: {e}"))?
            .first()
            .ok_or_else(|| format!("no public key labelled {label:?}"))?;

        let attrs = session
            .get_attributes(pub_handle, &[AttributeType::EcPoint])
            .map_err(|e| format!("read EC point: {e}"))?;
        let ec_point = attrs
            .into_iter()
            .find_map(|a| match a {
                Attribute::EcPoint(bytes) => Some(bytes),
                _ => None,
            })
            .ok_or("public key exposes no EC point")?;
        let public_key = parse_ed25519_point(&ec_point)?;

        Ok(Self {
            _ctx: ctx,
            session: Mutex::new(session),
            priv_handle,
            public_key,
        })
    }
}

/// Extract the raw 32-byte Ed25519 public key from a CKA_EC_POINT value.
///
/// PKCS#11 v3.0 stores the Ed25519 point as a DER OCTET STRING wrapping the 32
/// raw bytes (`0x04 0x20 || raw32`); some tokens return the raw 32 bytes.
fn parse_ed25519_point(ec: &[u8]) -> Result<[u8; 32], String> {
    let raw: &[u8] = match ec {
        [0x04, 0x20, rest @ ..] if rest.len() == 32 => rest,
        _ if ec.len() == 32 => ec,
        _ => return Err(format!("unexpected EC point length {}", ec.len())),
    };
    let mut out = [0u8; 32];
    out.copy_from_slice(raw);
    Ok(out)
}

impl Signer for Pkcs11Signer {
    fn public_key(&self) -> [u8; 32] {
        self.public_key
    }

    fn try_sign(&self, msg: &[u8]) -> Result<[u8; 64], SignerError> {
        let session = self
            .session
            .lock()
            .map_err(|_| SignerError::Backend("PKCS#11 session lock poisoned".to_owned()))?;
        let mechanism = Mechanism::Eddsa(EddsaParams::new(EddsaSignatureScheme::Ed25519));
        let sig = session
            .sign(&mechanism, self.priv_handle, msg)
            .map_err(|e| SignerError::Backend(format!("PKCS#11 sign: {e}")))?;
        let len = sig.len();
        sig.try_into()
            .map_err(|_| SignerError::InvalidSignatureLength(len))
    }
}
