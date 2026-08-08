resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

# object_lock_enabled is a top-level string attribute ("Enabled"), not a nested boolean block,
# and requires a rule { default_retention {...} } block to actually enforce anything — the exact
# schema mistake found in a real delegated-model run this benchmark is meant to catch.
resource "aws_s3_bucket_object_lock_configuration" "this" {
  bucket              = aws_s3_bucket.this.id
  object_lock_enabled = "Enabled"

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 365
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}
