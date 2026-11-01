use grep_regex::{RegexMatcher, RegexMatcherBuilder};

pub(super) fn matcher(query: &str) -> Result<RegexMatcher, String> {
    if query.trim().is_empty() {
        return Err("empty search text".into());
    }
    let mut escaped = String::with_capacity(query.len());
    for character in query.chars() {
        if "\\.+*?()|[]{}^$".contains(character) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    RegexMatcherBuilder::new()
        .case_insensitive(true)
        .line_terminator(Some(b'\n'))
        .build(&escaped)
        .map_err(|error| format!("invalid search text: {error}"))
}
