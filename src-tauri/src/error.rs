use serde::{Serialize, Serializer};
use specta::datatype::DataType;
use specta::{Type, Types};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("erreur d'entrée/sortie : {0}")]
    Io(#[from] std::io::Error),
    #[error("opération non supportée")]
    Unsupported,
    #[error("format en lecture seule")]
    ReadOnly,
    #[error("fichier trop volumineux")]
    TooLarge,
    #[error("fichier corrompu : {0}")]
    Corrupt(String),
    #[error("limite dépassée : {0}")]
    Limit(String),
    #[error("erreur d'outil externe : {0}")]
    External(String),
    #[error("opération annulée")]
    Cancelled,
    #[error("introuvable")]
    NotFound,
}

pub type Result<T> = std::result::Result<T, AppError>;

impl AppError {
    /// Code stable, traduit côté front via `errors.<code>`.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Io(_) => "io",
            AppError::Unsupported => "unsupported",
            AppError::ReadOnly => "readOnly",
            AppError::TooLarge => "tooLarge",
            AppError::Corrupt(_) => "corrupt",
            AppError::Limit(_) => "limit",
            AppError::External(_) => "external",
            AppError::Cancelled => "cancelled",
            AppError::NotFound => "notFound",
        }
    }
}

/// Forme sérialisée d'une erreur : `{ code, message }`.
#[derive(Serialize, Type)]
struct ErrorPayload {
    code: String,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        ErrorPayload {
            code: self.code().to_string(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

impl Type for AppError {
    fn definition(types: &mut Types) -> DataType {
        ErrorPayload::definition(types)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_and_message() {
        let v = serde_json::to_value(AppError::Corrupt("x".into())).unwrap();
        assert_eq!(v["code"], "corrupt");
        assert!(v["message"].as_str().unwrap().contains('x'));
        let v = serde_json::to_value(AppError::ReadOnly).unwrap();
        assert_eq!(v["code"], "readOnly");
    }
}
