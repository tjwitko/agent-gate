terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0.0"
    }
  }
}

provider "aws" {
  region                      = var.aws_region
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  access_key                  = "test"
  secret_key                  = "test"
}

module "logs_bucket" {
  source      = "./modules/storage"
  bucket_name = var.bucket_name
}

output "logs_bucket_name" {
  value = module.logs_bucket.bucket_name
}
