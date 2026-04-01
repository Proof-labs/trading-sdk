use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, Data, DeriveInput, Fields, Type};

/// Derive macro that generates `fn encode_abci(&self, w: &mut AbciEventWriter)`
/// for an enum where each variant has named fields.
///
/// Variant names are converted to snake_case event types.
/// Field types determine encoding:
///   - `u64`, `u32` → decimal string
///   - `[u8; N]`    → hex string
///   - `Side`       → "buy"/"sell" via Display
///   - enums with Display → `.to_string()`
///   - anything else with Display → `.to_string()`
///
/// Fields named with a leading underscore are skipped.
#[proc_macro_derive(AbciEvent)]
pub fn derive_abci_event(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let name = &input.ident;

    let variants = match &input.data {
        Data::Enum(data) => &data.variants,
        _ => panic!("AbciEvent can only be derived on enums"),
    };

    let arms: Vec<_> = variants
        .iter()
        .map(|variant| {
            let vname = &variant.ident;
            let event_type = to_snake_case(&vname.to_string());

            let fields = match &variant.fields {
                Fields::Named(f) => &f.named,
                _ => panic!("AbciEvent variants must have named fields"),
            };

            let field_names: Vec<_> = fields.iter().map(|f| f.ident.as_ref().unwrap()).collect();

            let attr_count = field_names.len() as u16;

            let write_stmts: Vec<_> = fields
                .iter()
                .map(|f| {
                    let fname = f.ident.as_ref().unwrap();
                    let key = fname.to_string();
                    let ty = &f.ty;

                    if is_byte_array(ty) {
                        quote! { w.write_attr_hex(#key, #fname); }
                    } else if is_u64(ty) {
                        quote! { w.write_attr_u64(#key, *#fname); }
                    } else if is_u32(ty) {
                        quote! { w.write_attr_u64(#key, *#fname as u64); }
                    } else {
                        // Fallback: anything with Display (enums like Side, CancelReason)
                        quote! { w.write_attr_display(#key, #fname); }
                    }
                })
                .collect();

            quote! {
                #name::#vname { #(#field_names),* } => {
                    w.begin_event(#event_type, #attr_count);
                    #(#write_stmts)*
                }
            }
        })
        .collect();

    let expanded = quote! {
        impl #name {
            pub fn encode_abci(&self, w: &mut crate::abci_event::AbciEventWriter) {
                match self {
                    #(#arms)*
                }
            }
        }
    };

    expanded.into()
}

fn to_snake_case(s: &str) -> String {
    let mut result = String::with_capacity(s.len() + 4);
    for (i, c) in s.chars().enumerate() {
        if c.is_uppercase() {
            if i > 0 {
                result.push('_');
            }
            result.push(c.to_ascii_lowercase());
        } else {
            result.push(c);
        }
    }
    result
}

fn is_byte_array(ty: &Type) -> bool {
    let s = quote!(#ty).to_string();
    s.starts_with("[u8 ;") || s.starts_with("[u8;")
}

fn is_u64(ty: &Type) -> bool {
    matches_ident(ty, "u64")
}

fn is_u32(ty: &Type) -> bool {
    matches_ident(ty, "u32")
}

fn matches_ident(ty: &Type, name: &str) -> bool {
    if let Type::Path(p) = ty {
        if let Some(seg) = p.path.segments.last() {
            return seg.ident == name;
        }
    }
    false
}
